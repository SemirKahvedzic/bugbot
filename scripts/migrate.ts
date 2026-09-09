/**
 * `npm run migrate` - apply pending migrations.
 *
 * A deliberate step, not something the app does on boot. On Vercel several
 * cold starts can begin at once, and a serverless function is the wrong place
 * to be altering a schema; the advisory lock inside runMigrations protects
 * against two of these running together.
 */
import 'dotenv/config';
import { z } from 'zod';
import { openDatabase, runMigrations } from '../src/db/index.js';

const envSchema = z.object({
  DATABASE_URL: z.string().url('must be a postgres:// connection string'),
});

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write('Cannot migrate - DATABASE_URL is not set.\n');
    process.stderr.write('Copy .env.example to .env and paste your Postgres connection string.\n');
    process.exit(1);
  }

  // Redact credentials before printing which database we are touching.
  const url = new URL(parsed.data.DATABASE_URL);
  process.stdout.write(`Migrating ${url.host}${url.pathname}\n`);

  const db = openDatabase({ connectionString: parsed.data.DATABASE_URL, max: 1 });

  try {
    const applied = await runMigrations(db);
    if (applied.length === 0) {
      process.stdout.write('Already up to date - nothing to apply.\n');
    } else {
      for (const id of applied) process.stdout.write(`  applied ${id}\n`);
    }

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    process.stdout.write(`Tables: ${tables.rows.map((row) => row.table_name).join(', ')}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
