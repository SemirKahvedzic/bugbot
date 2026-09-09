/**
 * Postgres access. All SQL lives under src/db/ (SPEC 3).
 *
 * Postgres rather than SQLite because BugBot is deployed to Vercel, where the
 * filesystem is ephemeral and per-instance. The `notifications` table is what
 * guarantees a redelivered webhook sends nothing twice; on a disappearing disk
 * that guarantee disappears with it, and duplicate DMs are the one failure
 * mode SPEC 7 singles out as trust-destroying.
 *
 * Everything goes through the small `Db` interface below rather than touching
 * `pg` directly, so the repository layer has no driver knowledge and tests can
 * run against an in-memory Postgres.
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg';

export interface QueryResult<T> {
  rows: T[];
  /** Rows actually inserted/updated/deleted. Used for ON CONFLICT DO NOTHING. */
  rowCount: number;
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs fn on a single dedicated connection inside BEGIN/COMMIT. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres returns COUNT(*) and bigint columns as strings. */
export function toCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function poolConfig(connectionString: string, max: number): PoolConfig {
  const config: PoolConfig = {
    connectionString,
    max,
    // Serverless invocations are short; do not hold connections open.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  };

  // Escape hatch for providers serving a certificate pg will not verify.
  // Normal hosted Postgres (Neon, Vercel, Supabase) needs none of this.
  if (process.env.DATABASE_SSL_NO_VERIFY === 'true') {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

class PgDb implements Db {
  constructor(private readonly pool: Pool) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(new PgClientDb(client));
      await client.query('COMMIT');
      return value;
    } catch (error) {
      // Leave the schema as it was rather than half-applied.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** A Db bound to one checked-out connection, for use inside a transaction. */
class PgClientDb implements Db {
  constructor(private readonly client: PoolClient) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.client.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Already inside one; nesting would need savepoints and nothing needs them.
    return fn(this);
  }

  async close(): Promise<void> {
    // The pool owns the connection's lifetime.
  }
}

export interface OpenDatabaseOptions {
  connectionString: string;
  max?: number;
}

export function openDatabase(options: OpenDatabaseOptions): Db {
  const pool = new Pool(poolConfig(options.connectionString, options.max ?? 5));
  // An idle client erroring must not take the process down.
  pool.on('error', () => undefined);
  return new PgDb(pool);
}

/**
 * Wrap an already-constructed pool.
 *
 * Exists so tests can hand in pg-mem's pool and exercise this exact
 * implementation - including the transaction handling - rather than a
 * lookalike written for the tests.
 */
export function wrapPool(pool: Pool): Db {
  return new PgDb(pool);
}

let cached: Db | undefined;

/**
 * Process-wide database handle.
 *
 * On Vercel this is created once per warm instance and reused across
 * invocations, which is the whole reason the pool sits at module scope.
 */
export function getDatabase(connectionString: string, max?: number): Db {
  if (!cached) cached = openDatabase({ connectionString, ...(max ? { max } : {}) });
  return cached;
}

export async function closeDatabase(): Promise<void> {
  if (cached) {
    const db = cached;
    cached = undefined;
    await db.close();
  }
}

/** Cheap liveness probe for /readyz. */
export async function pingDatabase(db: Db): Promise<boolean> {
  try {
    const result = await db.query<{ ok: number }>('SELECT 1 AS ok');
    return toCount(result.rows[0]?.ok) === 1;
  } catch {
    return false;
  }
}

export { runMigrations } from './migrate.js';
