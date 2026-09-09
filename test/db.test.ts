import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, toCount, type Db } from '../src/db/index.js';
import { makeTestDb } from './helpers/db.js';
import type { Migration } from '../src/db/migrations/index.js';

let db: Db;

beforeEach(async () => {
  db = await makeTestDb();
});

async function tableNames(handle: Db): Promise<string[]> {
  const result = await handle.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

describe('migrations', () => {
  it('creates the four SPEC 4 tables', async () => {
    const tables = await tableNames(db);
    expect(tables).toContain('issue_reports');
    expect(tables).toContain('user_map');
    expect(tables).toContain('notifications');
    expect(tables).toContain('triage_events');
    expect(tables).toContain('schema_migrations');
  });

  it('is idempotent - a second run applies nothing', async () => {
    // makeTestDb already migrated once.
    expect(await runMigrations(db, { lock: false })).toEqual([]);
    expect(await runMigrations(db, { lock: false })).toEqual([]);
  });

  it('records each applied migration exactly once', async () => {
    const result = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
    expect(result.rows.map((row) => row.id)).toEqual(['001_init']);
  });

  it('applies a new migration without re-running the old one', async () => {
    const extra: Migration = {
      id: '002_test_only',
      sql: 'CREATE TABLE probe (id INTEGER PRIMARY KEY)',
    };

    const applied = await runMigrations(db, {
      lock: false,
      list: [{ id: '001_init', sql: 'SELECT 1' }, extra],
    });

    expect(applied).toEqual(['002_test_only']);
    expect(await tableNames(db)).toContain('probe');
  });

  it('does not record a migration that failed', async () => {
    const broken: Migration = {
      id: '002_broken',
      sql: 'CREATE TABLE good (id INTEGER); THIS IS NOT SQL;',
    };

    await expect(runMigrations(db, { lock: false, list: [broken] })).rejects.toThrow();

    // Not recorded, so a fixed version can still be applied later.
    const recorded = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
    expect(recorded.rows.map((row) => row.id)).not.toContain('002_broken');

    // Whether the partial DDL was rolled back cannot be proven here: pg-mem
    // does not honour ROLLBACK. test/integration/postgres.test.ts checks it
    // against real Postgres.
  });
});

describe('schema shape', () => {
  it('keys issue_reports by issue key and allows an unknown reporter', async () => {
    await db.query(
      `INSERT INTO issue_reports
         (issue_key, slack_user_id, slack_channel_id, slack_thread_ts, intake_source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['SUP-1', 'U08HVG0H2EL', 'C0AU6L9FPME', '1725880000.001', 'slack_modal', '2026-09-09T10:00:00Z'],
    );

    // A bug created natively in Jira has no Slack identity yet (SPEC 4).
    await db.query(
      'INSERT INTO issue_reports (issue_key, intake_source, created_at) VALUES ($1, $2, $3)',
      ['SUP-2', 'jira_native', '2026-09-09T10:05:00Z'],
    );

    await expect(
      db.query(
        'INSERT INTO issue_reports (issue_key, intake_source, created_at) VALUES ($1, $2, $3)',
        ['SUP-1', 'slack_modal', '2026-09-09T10:10:00Z'],
      ),
    ).rejects.toThrow();
  });

  it('rejects a duplicate notification dedupe key, which is the whole point', async () => {
    await db.query('INSERT INTO notifications (dedupe_key, sent_at) VALUES ($1, $2)', [
      'SUP-1:jira:issue_updated:9001',
      '2026-09-09T10:00:00Z',
    ]);

    await expect(
      db.query('INSERT INTO notifications (dedupe_key, sent_at) VALUES ($1, $2)', [
        'SUP-1:jira:issue_updated:9001',
        '2026-09-09T10:00:01Z',
      ]),
    ).rejects.toThrow();
  });

  it('generates triage_events ids', async () => {
    for (const [key, routed] of [
      ['SUP-1', 'backlog'],
      ['SUP-2', 'sprint'],
    ]) {
      await db.query(
        `INSERT INTO triage_events (issue_key, from_status, to_status, priority, routed_to, actor_account_id, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [key, 'Under Triage', 'To Do', 'Low', routed, 'acc-1', '2026-09-09T10:00:00Z'],
      );
    }

    const result = await db.query<{ id: unknown; routed_to: string }>(
      'SELECT id, routed_to FROM triage_events ORDER BY id',
    );
    expect(result.rows.map((row) => toCount(row.id))).toEqual([1, 2]);
    expect(result.rows.map((row) => row.routed_to)).toEqual(['backlog', 'sprint']);
  });
});

describe('transactions', () => {
  it('commits on success', async () => {
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO notifications (dedupe_key, sent_at) VALUES ($1, $2)', [
        'committed',
        '2026-01-01T00:00:00Z',
      ]);
    });

    const result = await db.query('SELECT 1 FROM notifications WHERE dedupe_key = $1', [
      'committed',
    ]);
    expect(result.rows).toHaveLength(1);
  });

  it('propagates the failure to the caller', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO notifications (dedupe_key, sent_at) VALUES ($1, $2)', [
          'rolled-back',
          '2026-01-01T00:00:00Z',
        ]);
        throw new Error('something went wrong halfway');
      }),
    ).rejects.toThrow('something went wrong halfway');

    // That the insert was undone is a real-Postgres guarantee; pg-mem keeps
    // the row. See test/integration/postgres.test.ts.
  });
});

describe('toCount', () => {
  it('turns the strings Postgres returns for COUNT(*) into numbers', () => {
    // Forgetting this yields string concatenation instead of arithmetic.
    expect(toCount('42')).toBe(42);
    expect(toCount(42)).toBe(42);
    expect(toCount(null)).toBe(0);
    expect(toCount(undefined)).toBe(0);
    expect(toCount('not a number')).toBe(0);
  });
});
