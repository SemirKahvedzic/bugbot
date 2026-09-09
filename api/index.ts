/**
 * Vercel entry point.
 *
 * Everything under /api is routed here by vercel.json, so this one function
 * serves the Slack endpoint, the Jira webhook and the health checks. An
 * Express app is already a `(req, res)` handler, so exporting it is all Vercel
 * needs.
 *
 * The top-level await is deliberate: the module does not finish loading until
 * the Jira preflight has passed, so no request is ever handled by a
 * half-configured app. It runs once per cold start and every warm invocation
 * reuses it, along with the Postgres pool.
 *
 * Nothing here calls listen(). Vercel invokes the exported handler directly,
 * and a listening socket in a serverless function is a hang, not a server.
 */
import 'dotenv/config';
import { bootstrap, createFailClosedApp } from '../src/app.js';

const app = await bootstrap().then(
  (built) => built.expressApp,
  // A failed cold start must not take the deployment down silently: serve 503
  // with the reason, and let the next cold start try again.
  (error: unknown) => createFailClosedApp(error),
);

export default app;
