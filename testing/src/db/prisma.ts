import { Client } from 'pg';

/**
 * Postgres/Prisma integration harness (QA-CI T-026).
 *
 * Integration suites run ONLY when `TEST_DATABASE_URL` is set (a superuser-ish
 * connection that may CREATE/DROP DATABASE). CI provides it via `services:`;
 * locally it points at a throwaway server. Nothing here ever touches a real
 * stand database — every run gets its own ephemeral `qa_infra_*` database that
 * is dropped in afterAll.
 */

export function hasTestDatabase(): boolean {
  return !!process.env.TEST_DATABASE_URL;
}

/**
 * `describe` that self-skips when no `TEST_DATABASE_URL` is present, so unit +
 * component passes stay green on a machine without Postgres, while CI (with the
 * env) runs the real thing. Use for every Prisma-backed suite.
 */
export const describeIntegration: jest.Describe = (hasTestDatabase()
  ? describe
  : describe.skip) as jest.Describe;

/** A collision-resistant ephemeral database name, always `qa_infra_`-prefixed. */
export function ephemeralDbName(label = 'db'): string {
  const safe = label.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20);
  const rand = Math.random().toString(36).slice(2, 8);
  return `qa_infra_${safe}_${Date.now()}_${rand}`;
}

/** Swap the database (path) segment of a Postgres URL, preserving credentials/params. */
export function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = '/' + dbName;
  return u.toString();
}

/**
 * Create a fresh ephemeral database from the admin `TEST_DATABASE_URL` and return
 * its connection URL. `CREATE DATABASE` cannot run inside a transaction, so this
 * uses a raw pg client against the maintenance DB.
 */
export async function createEphemeralDatabase(label?: string): Promise<{
  url: string;
  dbName: string;
  drop: () => Promise<void>;
}> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) throw new Error('TEST_DATABASE_URL is not set');
  const dbName = ephemeralDbName(label);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(adminUrl, dbName);
  const drop = async (): Promise<void> => {
    const a = new Client({ connectionString: adminUrl });
    await a.connect();
    try {
      // Terminate stragglers so DROP DATABASE is not blocked by open sessions.
      await a.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await a.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await a.end();
    }
  };
  return { url, dbName, drop };
}

/** Minimal shape of a Prisma client sufficient for raw truncation. */
export interface RawExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * TRUNCATE the given fully-qualified tables (e.g. `"control"."Project"`) with
 * CASCADE + RESTART IDENTITY — a fast per-test reset that keeps the schema.
 */
export async function truncateTables(db: RawExecutor, tables: string[]): Promise<void> {
  if (tables.length === 0) return;
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`,
  );
}
