/**
 * Standalone server: local development, and the Docker image.
 *
 * Vercel does not use this file - `api/index.ts` is its entry point. The only
 * things this adds are listening on a port, socket mode for local development,
 * and graceful shutdown.
 *
 * A failed bootstrap serves the same fail-closed app that Vercel gets rather
 * than exiting: one behaviour to explain instead of two, and a webhook
 * receiver that refuses to start is worse than one that starts and reports
 * itself unready. The reason is logged at FATAL and /readyz says so too.
 */
import 'dotenv/config';
import { App } from '@slack/bolt';
import type { Application } from 'express';
import { bootstrap, createFailClosedApp, type BuiltApp } from './app.js';
import { ConfigError, getConfig, requireSlack } from './config.js';
import { closeDatabase } from './db/index.js';
import { logger } from './logger.js';
import { registerSlackHandlers } from './slack/register.js';

async function main(): Promise<void> {
  const log = logger();

  // Config first, and fatally: a server with an unusable environment has
  // nothing useful to offer, and the message lists every bad variable at once.
  // (A serverless function behaves differently - see api/index.ts.)
  let config;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  let built: BuiltApp | undefined;
  let expressApp: Application;

  try {
    built = await bootstrap();
    expressApp = built.expressApp;
  } catch (error) {
    // createFailClosedApp logs the reason, including whether it is a
    // configuration mismatch that no amount of retrying will fix.
    expressApp = createFailClosedApp(error);
  }

  const server = expressApp.listen(config.PORT, () => {
    log.info(
      { port: config.PORT, env: config.NODE_ENV, wired: Boolean(built) },
      built ? 'bugbot listening' : 'bugbot listening, but not wired - see the error above',
    );
  });

  // The idempotency ledger only needs recent history; without this it grows by
  // one row per notification forever. Only on a real boot - a serverless cold
  // start has no business doing housekeeping.
  if (built) {
    const pruned = await built.context.repo.pruneNotifications(30).catch(() => 0);
    if (pruned > 0) log.info({ pruned }, 'pruned old notification records');
  }

  // Socket Mode is a development convenience only (SPEC 3): Slack no longer
  // needs a public URL, but the Jira webhook still does, so the HTTP server
  // above stays up either way.
  let socketApp: App | undefined;
  if (built && config.SLACK_SOCKET_MODE) {
    const slack = requireSlack(config);
    socketApp = new App({
      token: slack.botToken,
      appToken: slack.appToken!,
      socketMode: true,
    });
    registerSlackHandlers(socketApp, built.context);
    await socketApp.start();
    log.info('bolt running in socket mode (development)');
  }

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    const done = async () => {
      await socketApp?.stop().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDatabase().catch(() => undefined);
      process.exit(0);
    };
    void done();
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Only an invalid environment reaches here - getConfig exits on its own, so
  // this is the last resort.
  logger().fatal(
    { err: error instanceof Error ? error.message : String(error) },
    'startup failed',
  );
  process.exit(1);
});
