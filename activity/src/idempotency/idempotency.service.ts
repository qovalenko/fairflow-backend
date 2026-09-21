import { Injectable } from '@nestjs/common';
import { withIdempotency } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';

/**
 * Per-domain mutation dedup (NFR-ACT-100). Wraps create so a client retry with the
 * same `Idempotency-Key` header runs at-most-once and replays the first response.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly mongo: MongoService) {}

  async withIdempotency<T>(
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
