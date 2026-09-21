import { Injectable } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { MongoService } from '../mongo/mongo.service';
import {
  ChainContent,
  ChainRecord,
  GENESIS_HASH,
  linkRecord,
  verifyChain,
  VerifyResult,
} from './hash-chain';

/**
 * Persistence + integrity service for the immutable audit hash-chain (E3-03).
 *
 * Two chain *levels*, distinguished by `chainKey` (TZ §5.6, BOARD K4a-audit):
 *  - **org-level**    `org|{organizationId}|{projectId}` — structural/admin facts
 *    (roles/permissions/modules/group-membership — R8, MANDATORY coverage);
 *  - **record-level** `record|{projectId}`              — CRM record changes.
 *
 * Append is append-only: seq allocation AND head-hash advance happen in one
 * atomic CAS (`updateOne` guarded by the expected `{seq, lastHash}`), so two
 * concurrent appends can never link to the same stale `prevHash` (TODO-034).
 * The chain record is inserted only after the CAS wins. There is no
 * UPDATE/DELETE path for existing `audit_events` rows (immutability; R8/M8.2).
 */
@Injectable()
export class AuditChainService {
  constructor(private readonly mongo: MongoService) {}

  static orgChainKey(organizationId: string, projectId?: string): string {
    return `org|${organizationId}|${projectId ?? ''}`;
  }

  static recordChainKey(projectId: string): string {
    return `record|${projectId}`;
  }

  /**
   * Dedup gate for the at-least-once consumer (RFC-4 §Р-4, FR-EVT-6). Two-phase
   * (TODO-033): a claim is written as `state: 'pending'` and only flips to
   * `'done'` via {@link confirmMessage} AFTER the chain append succeeds. On a
   * re-delivery a `'pending'` claim means the previous attempt died between
   * claim and confirm — the message must be re-processed, not skipped (the old
   * single-phase claim silently dropped the event forever, NFR-EVT-020).
   * Returns `true` if the caller should process the message, `false` if it was
   * already fully processed. `_id` = `idempotencyKey ?? messageId`.
   */
  async claimMessage(dedupKey: string): Promise<boolean> {
    try {
      await this.mongo
        .processedMessages()
        .insertOne({ _id: dedupKey as never, state: 'pending', processedAt: Date.now() });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error; // not a duplicate key
      const existing = (await this.mongo
        .processedMessages()
        .findOne({ _id: dedupKey as never })) as { state?: string } | null;
      // 'done' — fully processed. Legacy docs (no `state`) predate the two-phase
      // claim and are treated as done, same as before.
      if (existing?.state !== 'pending') return false;
      // 'pending' — prior attempt crashed/failed mid-flight. If its append DID
      // reach the chain (crash between append and confirm), finish the
      // bookkeeping and skip; otherwise take the claim over and re-process.
      const appended = await this.mongo.auditEvents().findOne({ idempotencyKey: dedupKey });
      if (appended) {
        await this.confirmMessage(dedupKey);
        return false;
      }
      return true;
    }
  }

  /** Phase 2 of the dedup claim: mark the message fully processed (append landed). */
  async confirmMessage(dedupKey: string): Promise<void> {
    await this.mongo
      .processedMessages()
      .updateOne({ _id: dedupKey as never }, { $set: { state: 'done', processedAt: Date.now() } });
  }

  /**
   * Append one content item to its chain. Seq allocation + head-hash advance are
   * a single CAS `updateOne` guarded by the expected `{seq, lastHash}` — a
   * concurrent append by the same chainKey makes the CAS miss and the loop
   * retries with a fresh head, so `prevHash` can never be stale (TODO-034; works
   * on standalone Mongo, no transactions needed). The chain record is inserted
   * into `audit_events` only after the CAS wins; if that insert fails, the head
   * is rolled back (best-effort CAS) so the seq is not burned and the retried
   * message can re-append without a seq gap (coordinated with TODO-033).
   * Returns the stored record (with seq/prevHash/hash). Caller pre-computes
   * `chainKey`.
   */
  async append(content: Omit<ChainContent, 'seq'>): Promise<ChainRecord> {
    const heads = this.mongo.auditChainHeads();
    const key = content.chainKey as never;
    // Genesis: make sure the head exists before the CAS loop. Existing heads
    // (legacy `$inc` format: seq = number of records, lastHash = tail hash) are
    // untouched and fully compatible with the CAS reads below.
    await heads.updateOne(
      { _id: key },
      { $setOnInsert: { seq: 0, lastHash: GENESIS_HASH } },
      { upsert: true },
    );

    for (;;) {
      const headDoc = (await heads.findOne({ _id: key })) as unknown as {
        seq?: number;
        lastHash?: string;
      } | null;
      const prevSeq = headDoc?.seq ?? 0;
      const prevHash = headDoc?.lastHash ?? GENESIS_HASH;
      const record = linkRecord(prevHash, { ...content, seq: prevSeq + 1 });

      const cas = await heads.updateOne(
        { _id: key, seq: prevSeq, lastHash: prevHash },
        { $set: { seq: record.seq, lastHash: record.hash } },
      );
      if (cas.matchedCount !== 1) continue; // CAS miss: another append advanced the head — retry

      // Denormalized query fields (NOT part of the hashed ChainContent / verify path):
      // `listEvents()` and `toRow()` read top-level eventName/entityType/entityId/payloadJson
      // (the RPC appendEvent() shape). Without these, consumer-ingested chain rows are
      // invisible to entity-filtered history queries (e.g. contacts/companies history).
      // `subject` is `<entityType>/<entityId>` (e.g. `contact/<id>`); split on the first '/'.
      const subject = record.subject ?? '';
      const slash = subject.indexOf('/');
      const entityType = slash >= 0 ? subject.slice(0, slash) : '';
      const entityId = slash >= 0 ? subject.slice(slash + 1) : '';

      try {
        await this.mongo.auditEvents().insertOne({
          _id: new ObjectId(),
          chainKey: record.chainKey,
          seq: record.seq,
          prevHash: record.prevHash,
          hash: record.hash,
          action: record.action,
          subject: record.subject ?? null,
          actorId: record.actorId ?? null,
          actorType: record.actorType ?? null,
          projectId: record.projectId ?? null,
          organizationId: record.organizationId ?? null,
          idempotencyKey: record.idempotencyKey ?? null,
          data: record.data ?? null,
          createdAt: record.createdAt,
          // denormalized, query-only (see note above)
          eventName: record.action,
          entityType: entityType || null,
          entityId: entityId || null,
          payloadJson: JSON.stringify(record.data ?? {}),
        });
      } catch (error) {
        // Best-effort compensating CAS: un-advance the head so the failed insert
        // does not leave a permanent seq gap. Succeeds unless another append
        // already advanced past us (then the gap stays detectable by verify()).
        await heads
          .updateOne(
            { _id: key, seq: record.seq, lastHash: record.hash },
            { $set: { seq: prevSeq, lastHash: prevHash } },
          )
          .catch(() => undefined);
        throw error;
      }

      return record;
    }
  }

  /** Load an ordered (asc seq) chain slice for verification. */
  async loadChain(chainKey: string): Promise<ChainRecord[]> {
    const rows = await this.mongo
      .auditEvents()
      .find({ chainKey })
      .sort({ seq: 1 })
      .toArray();
    return rows.map((r) => this.toChainRecord(r as Record<string, unknown>));
  }

  /** Verify integrity of an entire chain (org- or record-level). */
  async verify(chainKey: string): Promise<VerifyResult> {
    const records = await this.loadChain(chainKey);
    return verifyChain(records);
  }

  private toChainRecord(r: Record<string, unknown>): ChainRecord {
    return {
      chainKey: String(r.chainKey),
      seq: Number(r.seq),
      prevHash: String(r.prevHash),
      hash: String(r.hash),
      action: String(r.action),
      subject: r.subject == null ? undefined : String(r.subject),
      actorId: r.actorId == null ? undefined : String(r.actorId),
      actorType: r.actorType == null ? undefined : String(r.actorType),
      projectId: r.projectId == null ? undefined : String(r.projectId),
      organizationId: r.organizationId == null ? undefined : String(r.organizationId),
      idempotencyKey: r.idempotencyKey == null ? undefined : String(r.idempotencyKey),
      createdAt: Number(r.createdAt),
      data: r.data ?? undefined,
    };
  }
}
