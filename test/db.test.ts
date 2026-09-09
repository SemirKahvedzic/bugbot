import { describe, expect, it } from 'vitest';
import { openDatabase, pingDatabase, runMigrations } from '../src/db/index.js';
import type { Migration } from '../src/db/migrations/index.js';

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

describe('migrations', () => {
  it('creates the four SPEC 4 tables', () => {
    const db = openDatabase({ path: ':memory:' });
    const tables = tableNames(db);

    expect(tables).toContain('issue_reports');
    expect(tables).toContain('user_map');
    expect(tables).toContain('notifications');
    expect(tables).toContain('triage_events');
    expect(tables).toContain('schema_migrations');

    db.close();
  });

  it('is idempotent - a second run applies nothing', () => {
    const db = openDatabase({ path: ':memory:', migrate: false });

    const first = runMigrations(db);
    expect(first).toEqual(['001_init']);

    const second = runMigrations(db);
    expect(second).toEqual([]);

    db.close();
  });

  it('records each applied migration exactly once', () => {
    const db = openDatabase({ path: ':memory:' });
    runMigrations(db);

    const rows = db.prepare('SELECT id, applied_at FROM schema_migrations').all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string }).id).toBe('001_init');

    db.close();
  });

  it('applies a new migration without re-running the old one', () => {
    const db = openDatabase({ path: ':memory:' });
    const extra: Migration = {
      id: '002_test_only',
      sql: 'CREATE TABLE probe (id INTEGER PRIMARY KEY);',
    };

    const applied = runMigrations(db, [
      { id: '001_init', sql: 'SELECT 1;' },
      extra,
    ]);

    expect(applied).toEqual(['002_test_only']);
    expect(tableNames(db)).toContain('probe');

    db.close();
  });

  it('rolls a failing migration back rather than half-applying it', () => {
    const db = openDatabase({ path: ':memory:' });
    const broken: Migration = {
      id: '002_broken',
      sql: 'CREATE TABLE good (id INTEGER); THIS IS NOT SQL;',
    };

    expect(() => runMigrations(db, [broken])).toThrow();
    expect(tableNames(db)).not.toContain('good');

    db.close();
  });
});

describe('schema shape', () => {
  it('keys issue_reports by issue key and allows an unknown reporter', () => {
    const db = openDatabase({ path: ':memory:' });

    db.prepare(
      `INSERT INTO issue_reports
         (issue_key, slack_user_id, slack_channel_id, slack_thread_ts, intake_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('SUP-1', 'U08HVG0H2EL', 'C0AU6L9FPME', '1725880000.001', 'slack_modal', '2026-09-09T10:00:00Z');

    // A bug created natively in Jira has no Slack identity yet (SPEC 4).
    db.prepare(
      `INSERT INTO issue_reports (issue_key, intake_source, created_at) VALUES (?, ?, ?)`,
    ).run('SUP-2', 'jira_native', '2026-09-09T10:05:00Z');

    expect(() =>
      db
        .prepare('INSERT INTO issue_reports (issue_key, intake_source, created_at) VALUES (?, ?, ?)')
        .run('SUP-1', 'slack_modal', '2026-09-09T10:10:00Z'),
    ).toThrow(/UNIQUE/);

    db.close();
  });

  it('rejects a duplicate notification dedupe key, which is the whole point', () => {
    const db = openDatabase({ path: ':memory:' });
    const insert = db.prepare('INSERT INTO notifications (dedupe_key, sent_at) VALUES (?, ?)');

    insert.run('SUP-1:jira:issue_updated:9001', '2026-09-09T10:00:00Z');
    expect(() => insert.run('SUP-1:jira:issue_updated:9001', '2026-09-09T10:00:01Z')).toThrow(
      /UNIQUE/,
    );

    db.close();
  });

  it('autoincrements triage_events', () => {
    const db = openDatabase({ path: ':memory:' });
    const insert = db.prepare(
      `INSERT INTO triage_events
         (issue_key, from_status, to_status, priority, routed_to, actor_account_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    insert.run('SUP-1', 'Under Triage', 'To Do', 'Low', 'backlog', 'acc-1', '2026-09-09T10:00:00Z');
    insert.run('SUP-2', 'Under Triage', 'To Do', 'High', 'sprint', 'acc-1', '2026-09-09T10:01:00Z');

    const rows = db.prepare('SELECT id, routed_to FROM triage_events ORDER BY id').all() as Array<{
      id: number;
      routed_to: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows.map((r) => r.routed_to)).toEqual(['backlog', 'sprint']);

    db.close();
  });
});

describe('pingDatabase', () => {
  it('answers true for a live handle', () => {
    const db = openDatabase({ path: ':memory:' });
    expect(pingDatabase(db)).toBe(true);
    db.close();
  });
});
