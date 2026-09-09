/**
 * Bootstrap: validate config, open the DB, serve HTTP, then wire Slack and the
 * Jira webhook once the Jira side has been verified.
 *
 * Order matters. The HTTP listener comes up first so /healthz answers even
 * while Jira is unreachable - a webhook receiver that refuses to boot is worse
 * than one that boots and reports itself unready. Slack handlers and the Jira
 * webhook route are mounted only after the preflight succeeds, because both
 * need the service account id: without it the SPEC 7 loop guard cannot tell
 * our own writes apart from a human's, and BugBot would answer itself.
 */
import 'dotenv/config';
import { App, ExpressReceiver } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import express, { type Application } from 'express';
import { resolve } from 'node:path';
import { getConfig, hasSlackConfig, requireSlack, type Config } from './config.js';
import type { BugbotContext } from './context.js';
import { closeDatabase, getDatabase, pingDatabase, type Db } from './db/index.js';
import { Repo } from './db/repo.js';
import { Identity } from './identity.js';
import { JiraClient, type JiraMyself } from './jira/client.js';
import { Issues } from './jira/issues.js';
import { assertStatusesExist, JiraMeta, JiraMetaError } from './jira/meta.js';
import { createJiraWebhookRouter } from './jira/webhook.js';
import { logger } from './logger.js';
import { Notifier } from './slack/notify.js';
import { registerSlackHandlers } from './slack/register.js';
import { Leaders } from './triage/leaders.js';

const VERSION = process.env.BUGBOT_VERSION ?? '0.1.0';
const startedAt = Date.now();

/** Flipped once the Jira preflight has passed and the handlers are live. */
const state = { wired: false };

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

  // Readiness depends on the things every request needs: Jira, the DB, and
  // having actually finished wiring.
  app.get('/readyz', async (_req, res) => {
    const checks: Record<string, boolean> = { database: false, jira: false, wired: state.wired };
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

/**
 * Resolve every configured Jira name to an ID.
 *
 * A JiraMetaError means a name in .env does not match the live site. Retrying
 * will never fix that, and carrying on would file bugs into the wrong status,
 * so the caller exits on it. A network error is transient and gets retries.
 */
async function resolveJiraMeta(config: Config, jira: JiraClient): Promise<JiraMeta> {
  const log = logger();
  const meta = new JiraMeta(jira, {
    projectKey: config.JIRA_PROJECT_KEY,
    issueTypeName: config.JIRA_ISSUE_TYPE,
  });

  const attempts = 5;
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
      await new Promise((r) => setTimeout(r, 2000 * attempt));
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

/** Build the dependency bundle every handler receives. */
async function buildContext(input: {
  config: Config;
  db: Db;
  jira: JiraClient;
  slack: WebClient;
}): Promise<BugbotContext> {
  const { config, db, jira, slack } = input;
  const log = logger();

  const serviceAccount = await jira.get<JiraMyself>('/rest/api/3/myself');
  log.info(
    { accountId: serviceAccount.accountId, displayName: serviceAccount.displayName },
    'Jira service account',
  );

  const meta = await resolveJiraMeta(config, jira);
  const repo = new Repo(db);
  const issues = new Issues(jira, meta);
  const notifier = new Notifier(slack, log);
  const identity = new Identity({ slack, issues, repo, log });
  const leaders = new Leaders({
    path: resolve(process.cwd(), 'config/leaders.json'),
    fallbackSlackUserId: config.SLACK_DEFAULT_TRIAGER,
    log,
  });

  return {
    config,
    log,
    db,
    repo,
    jira,
    meta,
    issues,
    slack,
    notifier,
    identity,
    leaders,
    serviceAccount,
  };
}

async function main(): Promise<void> {
  const config = getConfig();
  const log = logger();

  const db = getDatabase(config.DATABASE_PATH);
  log.info({ path: config.DATABASE_PATH }, 'database ready');

  const jira = new JiraClient({
    baseUrl: config.JIRA_BASE_URL,
    email: config.JIRA_EMAIL,
    apiToken: config.JIRA_API_TOKEN,
  });

  const slackConfigured = hasSlackConfig(config);
  if (!slackConfigured) {
    log.warn(
      'Slack is not configured - serving health endpoints only. Fill SLACK_BOT_TOKEN and ' +
        'SLACK_SIGNING_SECRET to enable /bug and the rest.',
    );
  }

  let expressApp: Application;
  let boltApp: App | undefined;
  let stopServer: () => Promise<void>;

  if (slackConfigured && !config.SLACK_SOCKET_MODE) {
    // Bolt owns the express app, so its raw-body middleware stays ahead of
    // anything we add.
    const slack = requireSlack(config);
    const receiver = new ExpressReceiver({
      signingSecret: slack.signingSecret,
      endpoints: { events: '/slack/events' },
    });
    expressApp = receiver.app;
    expressApp.set('trust proxy', 1);
    mountHealthRoutes(expressApp, { db, jira });

    boltApp = new App({ token: slack.botToken, receiver });
    await boltApp.start(config.PORT);
    log.info({ port: config.PORT }, 'bolt listening, Slack events at /slack/events');
    stopServer = async () => {
      await boltApp?.stop();
    };
  } else {
    expressApp = express();
    expressApp.set('trust proxy', 1);
    mountHealthRoutes(expressApp, { db, jira });

    const server = expressApp.listen(config.PORT, () => {
      log.info({ port: config.PORT, env: config.NODE_ENV }, 'bugbot listening');
    });
    stopServer = () =>
      new Promise<void>((res) => {
        server.close(() => res());
      });

    if (slackConfigured && config.SLACK_SOCKET_MODE) {
      const slack = requireSlack(config);
      boltApp = new App({
        token: slack.botToken,
        appToken: slack.appToken!,
        socketMode: true,
      });
      await boltApp.start();
      log.info('bolt running in socket mode (development)');
    }
  }

  // Slack and the webhook are wired only after Jira checks out - see the note
  // at the top of the file.
  void (async () => {
    let context: BugbotContext;
    try {
      context = await buildContext({
        config,
        db,
        jira,
        slack: new WebClient(config.SLACK_BOT_TOKEN ?? ''),
      });
    } catch (error) {
      if (error instanceof JiraMetaError) {
        log.fatal({ err: error.message }, 'Jira configuration does not match the live site');
        process.exit(1);
      }
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Jira preflight failed - health endpoints are up but nothing is wired. ' +
          'Run `npm run discover` to see what is wrong, then restart.',
      );
      return;
    }

    if (boltApp) {
      registerSlackHandlers(boltApp, context);
    }

    // The idempotency ledger only needs recent history; without this it grows
    // by one row per notification forever.
    const pruned = context.repo.pruneNotifications(30);
    if (pruned > 0) log.info({ pruned }, 'pruned old notification records');

    if (config.JIRA_WEBHOOK_SECRET) {
      expressApp.use('/jira', createJiraWebhookRouter(context));
      log.info(
        { allowlist: config.JIRA_WEBHOOK_IP_ALLOWLIST.length },
        'Jira webhook mounted at /jira/webhook/:secret',
      );
      if (!slackConfigured) {
        // Worth saying out loud: routing will move issues and write labels,
        // but every notification will fail and be logged as an error.
        log.warn(
          'the Jira webhook is live but Slack is not configured - issues will be routed in ' +
            'Jira and nobody will be told about it',
        );
      }
    } else {
      log.warn(
        'JIRA_WEBHOOK_SECRET is not set - the Jira webhook is not mounted, so nothing is ' +
          'triaged automatically. Generate one with: openssl rand -hex 32',
      );
    }

    state.wired = true;
    log.info('bugbot ready');
  })();

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    void stopServer()
      .catch(() => undefined)
      .then(() => {
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
