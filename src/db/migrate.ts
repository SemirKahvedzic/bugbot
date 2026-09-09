/**
 * Migration runner.
 *
 * On Vercel several cold starts can begin at once, so migrations take a
 * Postgres advisory lock: whoever gets it migrates, the others wait and then
 * find nothing to do. Without the lock two instances would race to create the
 * same tables and one would error.
 *
 * Migrations are not run on boot. `npm run migrate` is a deliberate step -
 * see README - because a serverless function is the wrong place to be altering
 * a schema.
 */
import { migrations, type Migration } from './migrations/index.js';
import type { Db } from './index.js';

/** Arbitrary but fixed: any number works as long as it never changes. */
const MIGRATION_LOCK_ID = 4_242_001;

export interface RunMigrationsOptions {
  list?: Migration[];
  /**
   * Take the advisory lock. Off for tests, whose in-memory Postgres has no
   * advisory locks and no concurrency to protect against.
   */
  lock?: boolean;
}

export async function runMigrations(
  db: Db,
  options: RunMigrationsOptions = {},
): Promise<string[]> {
  const { list = migrations, lock = true } = options;

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  if (lock) await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

  try {
    const existing = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
    const alreadyApplied = new Set(existing.rows.map((row) => row.id));

    const applied: string[] = [];
    for (const migration of list) {
      if (alreadyApplied.has(migration.id)) continue;

      await db.transaction(async (tx) => {
        await tx.query(migration.sql);
        await tx.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)', [
          migration.id,
          new Date().toISOString(),
        ]);
      });

      applied.push(migration.id);
    }

    return applied;
  } finally {
    if (lock) await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
  }
}
