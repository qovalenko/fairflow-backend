import { Injectable } from '@nestjs/common';
import { withIdempotency } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';

/**
 * Per-domain mutation dedup (P2.d). Wraps a mutation so a client retry with the
 * same `Idempotency-Key` header runs it at-most-once and replays the first
 * response verbatim. Backed by the `idempotency_keys` ledger (unique
 * `{projectId, key}`, 24h TTL). See `withIdempotency` in `@fairflow/shared`.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly mongo: MongoService) {}

  /**
   * @param operation namespace so one header can't collapse two ops (`create`/`merge`/`import`).
   * @param key       raw `Idempotency-Key` (empty/undefined → no dedup, run once).
   */
  withIdempotency<T>(
    projectId: string,
    key: string | undefined,
    operation: string,
    executor: () => Promise<T>,
    extractRecordId?: (result: T) => string | undefined,
  ): Promise<T> {
    return withIdempotency(
      this.mongo.idempotencyKeys(),
      { projectId, key, operation, extractRecordId },
      executor,
    );
  }
}
