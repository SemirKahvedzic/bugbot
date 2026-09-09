/**
 * SQLite access. All SQL lives under src/db/ so Postgres stays a drop-in
 * replacement later (SPEC 3).
 *
 * Uses Node's built-in `node:sqlite` rather than `better-sqlite3`.
 * better-sqlite3 is a native module with no prebuilt binary for the Node
 * version on the dev machine, so installing it needed a node-gyp toolchain
 * (Python + Visual Studio build tools) that is not there. `node:sqlite` is the
 * same embedded SQLite with no compile step, which keeps `npm ci` working
 * everywhere and drops the build toolchain out of the Docker image. The
 * requirement that mattered - one small file we can back up by copying, all
 * SQL confined to this directory - is unchanged.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations, type Migration } from './migrations/index.js';

export type Db = DatabaseSync;

export interface OpenDatabaseOptions {
  /** File path, or ':memory:' for tests. */
  path: string;
  /** Run pending migrations on open. Default true. */
  migrate?: boolean;
  readonly?: boolean;
}

export function openDatabase(options: OpenDatabaseOptions): Db {
  const { path, migrate = true, readonly = false } = options;

  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path, { readOnly: readonly });

  // WAL keeps readers from blocking the webhook writer. Meaningless for an
  // in-memory database and rejected on a read-only handle.
  if (path !== ':memory:' && !readonly) {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  if (migrate && !readonly) runMigrations(db);
  return db;
}

/**
 * Apply every migration not yet recorded, each in its own transaction.
 * Idempotent: running twice is a no-op.
 */
export function runMigrations(db: Db, list: Migration[] = migrations): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const alreadyApplied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row) => String(row.id)),
  );

  const applied: string[] = [];
  const record = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  for (const migration of list) {
    if (alreadyApplied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      record.run(migration.id, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      // Leave the schema exactly as it was rather than half-migrated.
      db.exec('ROLLBACK');
      throw error;
    }
    applied.push(migration.id);
  }

  return applied;
}

/** Cheap liveness probe for /readyz. */
export function pingDatabase(db: Db): boolean {
  const row = db.prepare('SELECT 1 AS ok').get();
  return row?.ok === 1;
}

let cached: Db | undefined;

export function getDatabase(path: string): Db {
  if (!cached) cached = openDatabase({ path });
  return cached;
}

export function closeDatabase(): void {
  if (cached) {
    cached.close();
    cached = undefined;
  }
}
