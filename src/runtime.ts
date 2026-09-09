/**
 * Serverless plumbing.
 *
 * On Vercel a function stops executing the moment its response is sent, which
 * breaks the one pattern this whole service depends on: acknowledge Slack
 * inside three seconds, then do the slow Jira work. `waitUntil` is the
 * supported way to say "respond now, but keep this promise alive".
 *
 * The same code has to run on a normal long-lived server too - locally, and in
 * the Docker image - where there is nothing to tell and the promise simply
 * continues. So this wraps `waitUntil` and falls back to letting the promise
 * run, rather than making every call site care where it is.
 */
import { waitUntil as vercelWaitUntil } from '@vercel/functions';
import { logger } from './logger.js';

/** True when running inside a Vercel function. */
export const isServerless = Boolean(process.env.VERCEL);

/**
 * Keep `promise` alive past the response.
 *
 * Never rejects: a background failure is logged, because an unhandled
 * rejection in a serverless runtime can take the whole invocation down and
 * lose the request that is still in flight.
 */
export function keepAlive(promise: Promise<unknown>, description: string): void {
  const guarded = promise.catch((error: unknown) => {
    logger().error(
      { err: error instanceof Error ? error.message : String(error), task: description },
      'background task failed',
    );
  });

  if (isServerless) {
    try {
      vercelWaitUntil(guarded);
      return;
    } catch (error) {
      // Outside a request context waitUntil throws. The promise still runs,
      // but on a serverless platform the invocation may be frozen before it
      // finishes - so the work can vanish with no error anywhere. Say so
      // loudly: silent loss is the worst failure this module can have.
      logger().error(
        { task: description, err: error instanceof Error ? error.message : String(error) },
        'waitUntil unavailable on a serverless runtime - background work may be cut short',
      );
    }
  }

  void guarded;
}
