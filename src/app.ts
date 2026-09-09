/**
 * Builds the application without starting a server.
 *
 * Two entry points share this: `api/index.ts` exports the express app for
 * Vercel to invoke per request, and `src/index.ts` calls `listen` on it for
 * local development and the Docker image. Neither knows anything the other
 * does not.
 *
 * On Vercel this whole module runs once per cold start and is reused by every
 * warm invocation, which is why the Jira preflight and the connection pool
 * live here rather than inside a handler.
 */
import { App, ExpressReceiver } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import express, { type Application } from 'express';
import { ConfigError, getConfig, hasSlackConfig, requireSlack, type Config } from './config.js';
import type { BugbotContext } from './context.js';
import { getDatabase, pingDatabase, type Db } from './db/index.js';
import { Repo } from './db/repo.js';
import { Identity } from './identity.js';
import { JiraClient, type JiraMyself } from './jira/client.js';
import { Issues } from './jira/issues.js';
import { assertStatusesExist, JiraMeta, JiraMetaError } from './jira/meta.js';
import { createJiraWebhookRouter } from './jira/webhook.js';
import { logger } from './logger.js';
import { isServerless } from './runtime.js';
import { Notifier } from './slack/notify.js';
import { registerSlackHandlers } from './slack/register.js';
import { Leaders } from './triage/leaders.js';

export const VERSION = process.env.BUGBOT_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? '0.1.0';
const startedAt = Date.now();

export interface BuiltApp {
  expressApp: Application;
  boltApp?: App;
  context: BugbotContext;
  config: Config;
}

/**
 * Health routes.
 *
 * express.json() is applied per-route and never globally: a global JSON parser
 * mounted ahead of Bolt consumes the raw request body that Slack signature
 * verification needs (SPEC 11), and that failure mode is silent.
 */
function mountHealthRoutes(app: Application, deps: { db?: Db; jira?: JiraClient }): void {
  // Hitting the base URL should say what this is rather than 404. Also a
  // useful canary: the root is the one path Vercel needs its own rewrite rule
  // for, so if this stops answering, that rule has gone missing.
  app.get('/', (_req, res) => {
    res.status(200).json({
      service: 'bugbot',
      version: VERSION,
      endpoints: ['/healthz', '/readyz', '/slack/events', '/jira/webhook/:secret'],
    });
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'bugbot',
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      serverless: isServerless,
    });
  });

  app.get('/readyz', async (_req, res) => {
    const checks: Record<string, boolean> = { database: false, jira: false };

    checks.database = deps.db ? await pingDatabase(deps.db) : false;

    if (deps.jira) {
      try {
        const me = await deps.jira.get<JiraMyself>('/rest/api/3/myself');
        checks.jira = Boolean(me.accountId);
      } catch {
        checks.jira = false;
      }
    }

    const ok = Object.values(checks).every(Boolean);
    res.status(ok ? 200 : 503).json({ ok, checks, version: VERSION });
  });
}

/**
 * Resolve every configured Jira name to an ID.
 *
 * A JiraMetaError means a name in the environment does not match the live
 * site. Retrying will never fix that, and carrying on would file bugs into the
 * wrong status. A network error is transient and gets retries.
 */
async function resolveJiraMeta(config: Config, jira: JiraClient): Promise<JiraMeta> {
  const log = logger();
  const meta = new JiraMeta(jira, {
    projectKey: config.JIRA_PROJECT_KEY,
    issueTypeName: config.JIRA_ISSUE_TYPE,
    boardId: config.JIRA_BOARD_ID,
  });

  // Fewer, shorter retries on serverless: the caller is a request with its own
  // timeout, and a cold start that hangs for half a minute is worse than one
  // that fails and gets retried by Slack.
  const attempts = isServerless ? 2 : 5;
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
      await new Promise((r) => setTimeout(r, 1000 * attempt));
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

  // One instance of each: Identity caches through the same Repo the handlers
  // use, so a lookup done during intake is visible to the webhook immediately.
  const repo = new Repo(db);
  const issues = new Issues(jira, meta);

  return {
    config,
    log,
    db,
    repo,
    jira,
    meta,
    issues,
    slack,
    notifier: new Notifier(slack, log),
    identity: new Identity({ slack, issues, repo, log }),
    leaders: new Leaders({
      ...(config.BUGBOT_LEADERS ? { config: config.BUGBOT_LEADERS } : {}),
      fallbackSlackUserId: config.SLACK_DEFAULT_TRIAGER,
      log,
    }),
    serviceAccount,
  };
}

/**
 * Build everything. Throws on a configuration problem; the caller decides
 * whether that means exiting (a server) or serving 503 (a function).
 */
export async function bootstrap(): Promise<BuiltApp> {
  const config = getConfig();
  const log = logger();

  const db = getDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);

  const jira = new JiraClient({
    baseUrl: config.JIRA_BASE_URL,
    email: config.JIRA_EMAIL,
    apiToken: config.JIRA_API_TOKEN,
  });

  const slackConfigured = hasSlackConfig(config);
  let expressApp: Application;
  let boltApp: App | undefined;

  if (slackConfigured && !config.SLACK_SOCKET_MODE) {
    const slack = requireSlack(config);
    const receiver = new ExpressReceiver({
      signingSecret: slack.signingSecret,
      endpoints: { events: '/slack/events' },
      // On serverless the response must not be sent until handlers have
      // registered their background work, or the invocation is frozen first.
      processBeforeResponse: isServerless,
    });
    expressApp = receiver.app;
    // The ExpressReceiver registers its route in its constructor, so
    // constructing App is enough to make it live. start() only calls listen(),
    // which the entry point does - or, on Vercel, must never do.
    boltApp = new App({ token: slack.botToken, receiver });
  } else {
    expressApp = express();
    if (!slackConfigured) {
      log.warn(
        'Slack is not configured - health endpoints only. Set SLACK_BOT_TOKEN and ' +
          'SLACK_SIGNING_SECRET to enable /bug and the rest.',
      );
    }
  }

  // Vercel and Fly both terminate TLS at a proxy; trust one hop so req.ip is
  // the real client, which the webhook IP allowlist depends on.
  expressApp.set('trust proxy', 1);
  mountHealthRoutes(expressApp, { db, jira });

  const context = await buildContext({
    config,
    db,
    jira,
    slack: new WebClient(config.SLACK_BOT_TOKEN ?? ''),
  });

  if (boltApp) registerSlackHandlers(boltApp, context);

  if (config.JIRA_WEBHOOK_SECRET) {
    expressApp.use('/jira', createJiraWebhookRouter(context));
    log.info(
      { allowlist: config.JIRA_WEBHOOK_IP_ALLOWLIST.length },
      'Jira webhook mounted at /jira/webhook/:secret',
    );
    if (!slackConfigured) {
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

  log.info({ serverless: isServerless, version: VERSION }, 'bugbot ready');
  return { expressApp, ...(boltApp ? { boltApp } : {}), context, config };
}

/**
 * An app that answers /healthz but refuses everything else, used when
 * bootstrap fails on a serverless cold start.
 *
 * 503 rather than 500 on purpose: Slack backs off and retries a 503, and stops
 * trusting an endpoint that 500s repeatedly.
 */
export function createFailClosedApp(error: unknown): Application {
  const message = error instanceof Error ? error.message : String(error);
  const configProblem = error instanceof JiraMetaError || error instanceof ConfigError;
  const log = logger();

  log.fatal(
    { err: message, configProblem },
    configProblem
      ? 'configuration is wrong - fix the environment and redeploy'
      : 'bootstrap failed - serving 503 until the next cold start',
  );

  const app = express();
  app.set('trust proxy', 1);

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, service: 'bugbot', version: VERSION, wired: false });
  });

  app.all(/.*/, (_req, res) => {
    res.status(503).json({
      ok: false,
      error: 'bugbot failed to start',
      detail: message,
      hint: 'run `npm run discover` against this environment',
    });
  });

  return app;
}
