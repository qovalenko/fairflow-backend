import pg from 'pg';
import { BOX_CONN } from './env';

/** Minimal Postgres helper for control-schema test setup (purge schedule fast-forward). */
export class BoxPostgresHelper {
  private constructor(private readonly pool: pg.Pool) {}

  static async connect(): Promise<BoxPostgresHelper> {
    const pool = new pg.Pool({ connectionString: BOX_CONN.postgres });
    await pool.query('SELECT 1');
    return new BoxPostgresHelper(pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Move a pending_deletion project past its grace window so local purge job picks it up. */
  async fastForwardProjectDeletion(projectId: string): Promise<void> {
    await this.pool.query(
      `UPDATE control."Project"
       SET deletion_scheduled_at = NOW() - INTERVAL '1 hour'
       WHERE id = $1 AND status = 'pending_deletion'`,
      [projectId],
    );
  }

  async getProjectStatus(projectId: string): Promise<string | null> {
    const res = await this.pool.query<{ status: string }>(
      `SELECT status FROM control."Project" WHERE id = $1`,
      [projectId],
    );
    return res.rows[0]?.status ?? null;
  }

  /** True when local control relay marked the outbox row published for this project. */
  async hasPublishedOutbox(routingKey: string, projectId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM control."ControlOutbox"
       WHERE routing_key = $1 AND project_id = $2 AND status = 'published'
       ORDER BY created_at DESC
       LIMIT 1`,
      [routingKey, projectId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Latest published outbox envelope for diagnostics (control-side contract checks). */
  async getLatestPublishedOutboxEnvelope(
    routingKey: string,
    projectId: string,
  ): Promise<Record<string, unknown> | null> {
    const res = await this.pool.query<{ envelope: Record<string, unknown> }>(
      `SELECT envelope FROM control."ControlOutbox"
       WHERE routing_key = $1 AND project_id = $2 AND status = 'published'
       ORDER BY created_at DESC
       LIMIT 1`,
      [routingKey, projectId],
    );
    return res.rows[0]?.envelope ?? null;
  }
}
