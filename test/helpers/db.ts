/**
 * An in-memory Postgres for tests.
 *
 * pg-mem speaks enough Postgres for this schema, so the suite needs no running
 * database, no Docker and no network. It wraps the real `wrapPool`
 * implementation rather than a lookalike, so rowCount behaviour and the query
 * path are the ones that ship.
 *
 * Two things pg-mem does not do, both verified rather than assumed:
 *
 * - **Advisory locks** do not exist, hence `lock: false`. There is no
 *   concurrency to protect against in one test process anyway.
 * - **ROLLBACK is not honoured** through the pool adapter: a row inserted
 *   inside a transaction survives a rollback. So transaction atomicity - which
 *   migrations depend on - cannot be proven here. `test/integration/postgres.test.ts`
 *   covers it against real Postgres.
 *
 * `noAstCoverageCheck` is needed because pg-mem rejects a `CREATE TABLE IF NOT
 * EXISTS` whose table already exists, complaining that it never read the
 * column constraints. Real Postgres treats it as the no-op it is.
 */
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { runMigrations, toCount, wrapPool, type Db } from '../../src/db/index.js';

export async function makeTestDb(): Promise<Db> {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg() as { Pool: new () => Pool };
  const db = wrapPool(new adapter.Pool());
  await runMigrations(db, { lock: false });
  return db;
}

/** Rows from an ad-hoc query, for asserting on what the code wrote. */
export async function rows<T = Record<string, unknown>>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  return result.rows;
}

/**
 * How many rows a table holds.
 *
 * A helper rather than an inline COUNT(*) because Postgres returns counts as
 * strings, so `expect(row).toEqual({ n: 1 })` fails against `{ n: '1' }`.
 */
export async function countOf(db: Db, table: string, where = '', params: unknown[] = []): Promise<number> {
  const clause = where ? ` WHERE ${where}` : '';
  const result = await db.query<{ count: unknown }>(
    `SELECT COUNT(*) AS count FROM ${table}${clause}`,
    params,
  );
  return toCount(result.rows[0]?.count);
}
