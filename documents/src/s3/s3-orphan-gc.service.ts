import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MongoService } from '../mongo/mongo.service';
import { S3Service } from './s3.service';

/**
 * Background GC for S3 objects under `{projectId}/` that have no matching row in
 * `document_versions` or `template_revisions` (NFR-DOCS-050).
 *
 * Upload-order compensation on the gateway covers the happy-path rollback; this
 * sweeper catches orphans left by partial failures or standalone-Mongo best-effort
 * writes. Objects younger than the grace window are never deleted.
 */
@Injectable()
export class S3OrphanGcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(S3OrphanGcService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly enabled = process.env.S3_ORPHAN_GC_ENABLED !== 'false';
  private readonly intervalMs = Math.max(
    60_000,
    parseInt(process.env.S3_ORPHAN_GC_INTERVAL_MS ?? '3600000', 10) || 3_600_000,
  );
  private readonly graceMs = Math.max(
    60_000,
    parseInt(process.env.S3_ORPHAN_GC_GRACE_MS ?? '3600000', 10) || 3_600_000,
  );

  constructor(
    private readonly mongo: MongoService,
    private readonly s3: S3Service,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('S3 orphan GC disabled (S3_ORPHAN_GC_ENABLED=false)');
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.runOnce(), this.intervalMs);
  }

  /** One GC pass — exposed for tests. */
  async runOnce(now = Date.now()): Promise<{ scanned: number; deleted: number }> {
    if (this.running) return { scanned: 0, deleted: 0 };
    this.running = true;
    try {
      const referenced = await this.loadReferencedKeys();
      const { scanned, deleted } = await this.s3.deleteUnreferencedObjects(
        referenced,
        now - this.graceMs,
      );
      if (deleted > 0) {
        this.logger.warn(`S3 orphan GC: scanned=${scanned} deleted=${deleted}`);
      }
      return { scanned, deleted };
    } catch (err) {
      this.logger.error(
        `S3 orphan GC failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { scanned: 0, deleted: 0 };
    } finally {
      this.running = false;
      if (this.enabled) this.schedule();
    }
  }

  private async loadReferencedKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    const versionRows = await this.mongo
      .documentVersions()
      .find({}, { projection: { objectKey: 1 } })
      .toArray();
    for (const row of versionRows) {
      const k = String((row as { objectKey?: string }).objectKey ?? '');
      if (k) keys.add(k);
    }
    const revisionRows = await this.mongo
      .templateRevisions()
      .find({}, { projection: { objectKey: 1 } })
      .toArray();
    for (const row of revisionRows) {
      const k = String((row as { objectKey?: string }).objectKey ?? '');
      if (k) keys.add(k);
    }
    return keys;
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
