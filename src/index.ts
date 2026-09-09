/**
 * Bootstrap: validate config, open the DB, resolve Jira metadata, serve HTTP.
 *
 * Phase 0 mounts no Slack handlers - it proves the process boots, the Jira
 * credentials work, and /healthz answers. Phase 1 adds the commands.
 */
import 'dotenv/config';
import express, { type Application } from 'express';
import { ExpressReceiver } from '@slack/bolt';
import { getConfig, hasSlackConfig, requireSlack, type Config } from './config.js';
import { logger } from './logger.js';
import { closeDatabase, getDatabase, pingDatabase, type Db } from './db/index.js';
import { JiraClient, type JiraMyself } from './jira/client.js';
import { assertStatusesExist, JiraMeta, JiraMetaError } from './jira/meta.js';

const VERSION = process.env.BUGBOT_VERSION ?? '0.1.0';
const startedAt = Date.now();

interface HealthDeps {
  db: Db;
  jira: JiraClient;
}

/**
 * Health routes.
 *
 * express.json() is applied per-route and never globally: a global JSON parser
 * mounted ahead of Bolt consumes the raw request body that Slack signature
 * verification needs (SPEC 11), and that failure mode is silent.
 */
function mountHealthRoutes(app: Application, deps: HealthDeps): void {
  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'bugbot',
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  // Readiness depends on the two things every request needs: Jira and the DB.
  app.get('/readyz', async (_req, res) => {
    const checks: Record<string, boolean> = { database: false, jira: false };
    try {
      checks.database = pingDatabase(deps.db);
    } catch {
      checks.database = false;
    }
    try {
      const me = await deps.jira.get<JiraMyself>('/rest/api/3/myself');
      checks.jira = Boolean(me.accountId);
    } catch {
      checks.jira = false;
    }
    const ok = Object.values(checks).every(Boolean);
    res.status(ok ? 200 : 503).json({ ok, checks, version: VERSION });
  });
}

function buildJiraClient(config: Config): JiraClient {
  return new JiraClient({
    baseUrl: config.JIRA_BASE_URL,
    email: config.JIRA_EMAIL,
    apiToken: config.JIRA_API_TOKEN,
  });
}

/**
 * Resolve every configured Jira name to an ID.
 *
 * Called after the HTTP listener is up, so that a Jira outage degrades the
 * service to "not ready" instead of preventing it from booting at all - a
 * webhook receiver that will not start is worse than one that starts and says
 * it is unhealthy.
 *
 * A JiraMetaError is different: a name in .env does not match the live site.
 * Retrying will never fix that, and carrying on would file bugs into the wrong
 * status, so the caller exits on it.
 */
async function resolveJiraMeta(config: Config, jira: JiraClient): Promise<JiraMeta> {
  const log = logger();
  const meta = new JiraMeta(jira, {
    projectKey: config.JIRA_PROJECT_KEY,
    issueTypeName: config.JIRA_ISSUE_TYPE,
  });

  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await meta.load();
      break;
    } catch (error) {
      if (attempt === attempts) throw error;
      log.warn(
        { attempt, attempts, err: (error as Error).message },
        'could not read Jira metadata, retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }

  assertStatusesExist(meta, {
    JIRA_STATUS_TRIAGE: config.JIRA_STATUS_TRIAGE,
    JIRA_STATUS_BACKLOG: config.JIRA_STATUS_BACKLOG,
    JIRA_STATUS_REJECTED: config.JIRA_STATUS_REJECTED,
    JIRA_STATUS_DUPLICATE: config.JIRA_STATUS_DUPLICATE,
    JIRA_STATUS_CANNOT_REPRODUCE: config.JIRA_STATUS_CANNOT_REPRODUCE,
  });

  log.info(
    {
      project: `${meta.projectKey} (${meta.projectId})`,
      issueType: `${meta.issueTypeName} (${meta.issueTypeId})`,
      statuses: meta.statusNames(),
    },
    'Jira metadata resolved',
  );

  return meta;
}

/**
 * Verify the Jira side once, in the background.
 *
 * Exits on a configuration mismatch, tolerates an outage. Phase 3 will reuse
 * the resolved metadata; Phase 0 only needs to prove the credentials work.
 */
async function jiraPreflight(config: Config, jira: JiraClient): Promise<void> {
  const log = logger();
  try {
    const me = await jira.get<JiraMyself>('/rest/api/3/myself');
    // accountId is the loop guard for Phase 3: ignore webhooks we caused.
    log.info({ accountId: me.accountId, displayName: me.displayName }, 'Jira service account');

    await resolveJiraMeta(config, jira);
    log.info('Jira preflight passed');
  } catch (error) {
    if (error instanceof JiraMetaError) {
      log.fatal({ err: error.message }, 'Jira configuration does not match the live site');
      process.exit(1);
    }
    log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'Jira preflight failed - serving anyway, /readyz will report not ready. ' +
        'Run `npm run discover` to see what is wrong.',
    );
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  const log = logger();

  const db = getDatabase(config.DATABASE_PATH);
  log.info({ path: config.DATABASE_PATH }, 'database ready');

  const jira = buildJiraClient(config);

  // Bolt owns the express app when Slack is configured, so its raw-body
  // middleware stays ahead of anything we add.
  let app: Application;
  if (hasSlackConfig(config) && !config.SLACK_SOCKET_MODE) {
    const slack = requireSlack(config);
    const receiver = new ExpressReceiver({
      signingSecret: slack.signingSecret,
      endpoints: { events: '/slack/events' },
      processBeforeResponse: true,
    });
    app = receiver.app;
    log.info('Slack HTTP receiver mounted at /slack/events');
  } else {
    app = express();
    log.warn(
      { socketMode: config.SLACK_SOCKET_MODE },
      'Slack HTTP receiver not mounted (credentials absent or socket mode on) - Phase 0 behaviour',
    );
  }

  // Fly terminates TLS at its proxy; trust one hop so req.ip is the client.
  app.set('trust proxy', 1);
  mountHealthRoutes(app, { db, jira });

  const server = app.listen(config.PORT, () => {
    log.info({ port: config.PORT, env: config.NODE_ENV }, 'bugbot listening');
  });

  // Deliberately not awaited: /healthz must answer even while Jira is checked.
  void jiraPreflight(config, jira);

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger().fatal(
    { err: error instanceof Error ? error.message : String(error) },
    'startup failed',
  );
  process.exit(1);
});
