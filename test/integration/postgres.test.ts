/**
 * Integration tests against a real Postgres.
 *
 * These cover the guarantees the in-memory suite cannot prove, because pg-mem
 * does not implement them:
 *
 *   - transaction rollback, which migration atomicity depends on
 *   - the atomicity of the idempotency claim under genuine concurrency
 *   - the digest window, whose conditional UPDATE pg-mem ignores
 *   - COUNT(*) coming back as a string
 *
 * Skipped unless TEST_DATABASE_URL is set, so the default suite stays offline.
 * Every row it writes is prefixed and deleted afterwards, so it is safe to
 * point at the same database the app uses.
 *
 *   TEST_DATABASE_URL="postgresql://..." npm run test:integration
 */
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, toCount, type Db } from '../../src/db/index.js';
import { Repo } from '../../src/db/repo.js';

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const enabled = Boolean(connectionString);

/** Unique per run, so a leftover row can never affect a later run. */
const RUN = `itest-${Date.now().toString(36)}`;
const issueKey = (suffix: string) => `ITEST-${RUN}-${suffix}`;

let db: Db;
let repo: Repo;

beforeAll(async () => {
  if (!enabled) return;
  db = openDatabase({ connectionString: connectionString!, max: 5 });
  await runMigrations(db);
  repo = new Repo(db);
});

afterAll(async () => {
  if (!enabled) return;
  await db.query('DELETE FROM notifications WHERE dedupe_key LIKE $1', [`${RUN}%`]);
  await db.query('DELETE FROM issue_reports WHERE issue_key LIKE $1', [`ITEST-${RUN}%`]);
  await db.query('DELETE FROM triage_events WHERE issue_key LIKE $1', [`ITEST-${RUN}%`]);
  await db.query('DELETE FROM user_map WHERE slack_user_id LIKE $1', [`${RUN}%`]);
  await db.close();
});

describe.skipIf(!enabled)('real Postgres: schema', () => {
  it('has the four SPEC 4 tables after migrating', async () => {
    const result = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = result.rows.map((row) => row.table_name);
    expect(tables).toContain('issue_reports');
    expect(tables).toContain('user_map');
    expect(tables).toContain('notifications');
    expect(tables).toContain('triage_events');
  });

  it('is idempotent to migrate again, advisory lock and all', async () => {
    expect(await runMigrations(db)).toEqual([]);
  });
});

describe.skipIf(!enabled)('real Postgres: transactions', () => {
  it('rolls back on failure, which pg-mem cannot show', async () => {
    const key = `${RUN}-rollback`;

    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO notifications (dedupe_key, sent_at) VALUES ($1, $2)', [
          key,
          new Date().toISOString(),
        ]);
        // Prove the row is visible inside the transaction...
        const inside = await tx.query('SELECT 1 FROM notifications WHERE dedupe_key = $1', [key]);
        expect(inside.rows).toHaveLength(1);
        throw new Error('deliberate failure');
      }),
    ).rejects.toThrow('deliberate failure');

    // ...and gone outside it.
    const after = await db.query('SELECT 1 FROM notifications WHERE dedupe_key = $1', [key]);
    expect(after.rows).toHaveLength(0);
  });

  it('releases the connection back to the pool after a rollback', async () => {
    // A leaked connection would make this hang or exhaust the pool.
    for (let i = 0; i < 8; i += 1) {
      await db
        .transaction(async () => {
          throw new Error('boom');
        })
        .catch(() => undefined);
    }
    const alive = await db.query<{ ok: number }>('SELECT 1 AS ok');
    expect(toCount(alive.rows[0]?.ok)).toBe(1);
  });
});

describe.skipIf(!enabled)('real Postgres: idempotency under concurrency (SPEC 7)', () => {
  it('lets exactly one of many concurrent claims win', async () => {
    const key = `${RUN}-concurrent`;

    // The scenario that matters: Jira redelivers a webhook while the first
    // delivery is still being handled, on two different warm instances.
    const results = await Promise.all(
      Array.from({ length: 12 }, () => repo.claimNotification(key)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('keeps different keys independent', async () => {
    const results = await Promise.all([
      repo.claimNotification(`${RUN}-a`),
      repo.claimNotification(`${RUN}-b`),
      repo.claimNotification(`${RUN}-c`),
    ]);
    expect(results).toEqual([true, true, true]);
  });
});

describe.skipIf(!enabled)('real Postgres: digest window (SPEC 8)', () => {
  it('sends once, then suppresses inside the window', async () => {
    const key = `${RUN}-digest`;
    expect(await repo.claimDigest(key, 300_000)).toBe(true);
    expect(await repo.claimDigest(key, 300_000)).toBe(false);
    expect(await repo.claimDigest(key, 300_000)).toBe(false);
  });

  it('sends again once the window has passed, and restarts the clock', async () => {
    const key = `${RUN}-digest-elapsed`;
    expect(await repo.claimDigest(key, 300_000)).toBe(true);

    await db.query('UPDATE notifications SET sent_at = $1 WHERE dedupe_key = $2', [
      new Date(Date.now() - 600_000).toISOString(),
      key,
    ]);

    expect(await repo.claimDigest(key, 300_000)).toBe(true);
    expect(await repo.claimDigest(key, 300_000)).toBe(false);
  });

  it('lets exactly one concurrent caller through the window', async () => {
    const key = `${RUN}-digest-race`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => repo.claimDigest(key, 300_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe.skipIf(!enabled)('real Postgres: the repository against real types', () => {
  it('round-trips an issue report and merges without erasing', async () => {
    const key = issueKey('report');

    await repo.recordIssueReport({
      issueKey: key,
      slackUserId: 'U_ITEST',
      slackChannelId: 'C_ITEST',
      intakeSource: 'slack_modal',
    });
    await repo.setThread(key, 'C_ITEST', '111.222');

    // A later, less informed write must not erase what we already know.
    await repo.recordIssueReport({ issueKey: key, intakeSource: 'jira_native' });

    const row = await repo.getIssueReport(key);
    expect(row?.slack_user_id).toBe('U_ITEST');
    expect(row?.slack_thread_ts).toBe('111.222');

    expect((await repo.findByThread('C_ITEST', '111.222'))?.issue_key).toBe(key);
  });

  it('returns numbers, not strings, from the metric queries', async () => {
    const key = issueKey('metrics');
    await repo.recordIssueReport({
      issueKey: key,
      slackUserId: `${RUN}-reporter`,
      intakeSource: 'slack_modal',
    });
    await repo.recordTriageEvent({ issueKey: key, routedTo: 'backlog', priority: 'Low' });

    const since = new Date(Date.now() - 3600_000).toISOString();

    const routing = await repo.routingSplitSince(since);
    const backlog = routing.find((row) => row.routed_to === 'backlog');
    expect(typeof backlog?.count).toBe('number');
    expect(backlog!.count).toBeGreaterThanOrEqual(1);

    const reporters = await repo.topReportersSince(since, 10);
    const mine = reporters.find((row) => row.slack_user_id === `${RUN}-reporter`);
    expect(typeof mine?.count).toBe('number');
    expect(mine?.count).toBe(1);

    const intake = await repo.intakeSince(since);
    expect(intake.every((row) => typeof row.count === 'number')).toBe(true);
  });

  it('computes a median time in triage', async () => {
    const key = issueKey('median');
    await repo.recordIssueReport({ issueKey: key, intakeSource: 'slack_modal' });
    await db.query('UPDATE issue_reports SET created_at = $1 WHERE issue_key = $2', [
      new Date(Date.now() - 7200_000).toISOString(),
      key,
    ]);
    await repo.recordTriageEvent({ issueKey: key, routedTo: 'backlog' });

    const median = await repo.medianTimeInTriageMs(new Date(Date.now() - 86_400_000).toISOString());
    expect(median).toBeDefined();
    expect(median!).toBeGreaterThan(0);
  });

  it('caches an identity both ways', async () => {
    const slackUserId = `${RUN}-user`;
    await repo.upsertUserMap({ slackUserId, email: 'Itest@Roarington.com' });
    await repo.upsertUserMap({ slackUserId, jiraAccountId: 'acc-itest' });

    const bySlack = await repo.userBySlackId(slackUserId);
    expect(bySlack?.email).toBe('Itest@Roarington.com');
    expect(bySlack?.jira_account_id).toBe('acc-itest');

    // Case-insensitive, because Slack and Jira disagree about capitalisation.
    expect((await repo.userByEmail('itest@roarington.com'))?.slack_user_id).toBe(slackUserId);
    expect((await repo.userByJiraAccountId('acc-itest'))?.slack_user_id).toBe(slackUserId);
  });
});
