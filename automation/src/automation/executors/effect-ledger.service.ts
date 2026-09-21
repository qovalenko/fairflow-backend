import { Injectable, Logger } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { MongoService } from '../../mongo/mongo.service';

/** Ledger rows are kept a week — long enough to outlive every retry ladder. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * At-most-once ledger for action effects that the TARGET domain cannot dedup.
 *
 * `assign_user` / `change_stage` / `update_field` are made idempotent by
 * read-before-write (the record either already holds the value or it does not).
 * `send_notification` has no such handle: `NotificationGrpc.Send` happily creates
 * a second row, so a broker redelivery or a janitor re-drive of a claimed-but-
 * unfinished execution would notify the user twice.
 *
 * The claim is a unique-index insert on the effect key, taken BEFORE the effect:
 * whoever inserts runs, everyone else is told the effect is already accounted
 * for. The key carries the retry GENERATION (see `ActionDispatcher`), so an
 * operator-requested DLQ retry — which by design must reach the user — gets a
 * fresh key and is not swallowed as a duplicate. That is the same two-generation
 * discipline the order saga uses for `payloadGen:sendGen`, and the reason the
 * previous attempt at retries silently did nothing.
 */
@Injectable()
export class EffectLedger {
  private readonly logger = new Logger(EffectLedger.name);

  constructor(private readonly mongo: MongoService) {}

  /**
   * Try to claim `effectKey`. `true` → the caller owns the effect and must run
   * it; `false` → someone already did (or is doing) it, skip.
   *
   * Fails OPEN (returns true) when the ledger itself is unavailable: dropping a
   * user's notification because Mongo hiccuped is worse than a rare duplicate,
   * and the caller's own retry ladder is bounded.
   */
  async claim(projectId: string, effectKey: string): Promise<boolean> {
    if (!effectKey) return true;
    try {
      await this.mongo.actionEffects().insertOne({
        _id: new ObjectId(),
        effect_key: effectKey,
        project_id: projectId,
        created_at: Date.now(),
        expires_at: new Date(Date.now() + TTL_MS),
      });
      return true;
    } catch (err) {
      if (this.isDuplicateKeyError(err)) return false;
      this.logger.warn(`effect ledger claim failed for ${effectKey}: ${String(err)}`);
      return true;
    }
  }

  /**
   * Release a claim whose effect did NOT happen (the call failed before landing).
   * Without this a transient failure would burn the key and the retry — same
   * generation — would be skipped as a "duplicate" while nothing was ever sent.
   */
  async release(effectKey: string): Promise<void> {
    if (!effectKey) return;
    try {
      await this.mongo.actionEffects().deleteOne({ effect_key: effectKey });
    } catch (err) {
      this.logger.warn(`effect ledger release failed for ${effectKey}: ${String(err)}`);
    }
  }

  private isDuplicateKeyError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: number }).code === 11000
    );
  }
}
