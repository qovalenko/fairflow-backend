/** Cached the box stand system anchor + platform owner (read once per process). */
export interface BoxSystemContext {
  systemOrgId: string;
  platformOwnerUserId: string;
}

let cached: BoxSystemContext | null = null;

/**
 * Resolve the singleton system org anchor and platform owner from the box stand Postgres.
 * Read-only — does not mutate shared data.
 */
export async function resolveBoxSystemContext(): Promise<BoxSystemContext> {
  if (cached) return cached;

  const host = process.env.BOX_FF_HOST ?? 'localhost';
  const connectionString =
    process.env.BOX_POSTGRES_URL ??
    process.env.DATABASE_URL ??
    `postgresql://fairflow:CHANGE_ME@${host}:5432/fairflow`;

  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const sys = await client.query(
      'SELECT id FROM control.system_settings WHERE is_active = true ORDER BY created_at ASC LIMIT 1',
    );
    const systemOrgId = sys.rows[0]?.id as string | undefined;
    if (!systemOrgId) throw new Error('the box stand: no active system_settings row');

    const emp = await client.query(
      `SELECT user_id FROM control."Employee"
       WHERE organization_id = $1 AND role = 'platform_owner' AND is_active = true
       ORDER BY created_at ASC LIMIT 1`,
      [systemOrgId],
    );
    const platformOwnerUserId = emp.rows[0]?.user_id as string | undefined;
    if (!platformOwnerUserId) throw new Error('the box stand: no platform_owner employee');

    cached = { systemOrgId, platformOwnerUserId };
    return cached;
  } finally {
    await client.end();
  }
}
