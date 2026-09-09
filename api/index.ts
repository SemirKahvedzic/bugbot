/**
 * Vercel entry point.
 *
 * Everything under / is routed here by vercel.json, so this one function
 * serves the Slack endpoint, the Jira webhook and the health checks.
 *
 * The default export is a plain handler function, and the bootstrap is
 * deliberately *not* a top-level await. Vercel inspects the entry module and
 * requires the default export to be a function or a server; with a top-level
 * await it resolved the entry to a traced dependency instead and failed with
 * "Invalid export found in module /var/task/src/app.js". A handler function
 * with a cached promise is the shape Vercel expects, and it behaves the same
 * way: the bootstrap runs once per instance, the first request waits for it,
 * and every warm invocation reuses it along with the Postgres pool.
 *
 * Nothing here calls listen(). Vercel invokes the exported handler directly,
 * and a listening socket in a serverless function is a hang, not a server.
 */
import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Application } from 'express';
import { bootstrap, createFailClosedApp } from '../src/app.js';

let cached: Promise<Application> | undefined;

function app(): Promise<Application> {
  // A failed cold start must not take the deployment down silently: serve 503
  // with the reason, and let the next cold start try again.
  cached ??= bootstrap().then(
    (built) => built.expressApp,
    (error: unknown) => createFailClosedApp(error),
  );
  return cached;
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const express = await app();
  express(request, response);
}
