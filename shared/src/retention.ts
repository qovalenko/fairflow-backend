/**
 * Retention phase resolution — FR-NFR-24 (cross-cutting-nfr §4.7, canon §17).
 *
 * Three-stage model, driven by field conventions (FR-NFR-24, §5.5), not by a
 * per-area cron with hard-coded periods:
 *   live → soft (deletedAt) → archived (archivedAt) → purgeable (purgeAfter).
 *
 * Periods come from {@link PLATFORM_CONSTANTS} (defaults fixed by canon §17.1).
 * This module is pure: a retention mover/cron in a domain calls {@link phaseOf}
 * / {@link computeRetentionMarks} and applies the field updates / TTL indexes.
 * `shared` owns the math so every domain ages records identically.
 */

import { PLATFORM_CONSTANTS } from './platform-constants';

export type RetentionPhase = 'live' | 'soft' | 'archived' | 'purgeable';

/** Retention field convention (§5.5) carried by every retainable record. */
export interface RetentionMarks {
  /** soft-delete instant; null/undefined = live. */
  deletedAt?: Date | null;
  /** moved to read-only archive. */
  archivedAt?: Date | null;
  /** hard-delete eligibility instant (Mongo TTL index target). */
  purgeAfter?: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Add whole months to a date (UTC, clamps day-of-month). */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * Resolve the current retention phase of a record at time `now`.
 *  - no `deletedAt`            → `live`
 *  - `deletedAt`, no archive   → `soft`
 *  - `archivedAt`, before purge→ `archived`
 *  - `now >= purgeAfter`       → `purgeable` (body + PII may be erased; audit /
 *    lineage survive — FR-NFR-27).
 */
export function phaseOf(marks: RetentionMarks, now: Date = new Date()): RetentionPhase {
  if (!marks.deletedAt) return 'live';
  if (marks.purgeAfter && now.getTime() >= marks.purgeAfter.getTime()) return 'purgeable';
  if (marks.archivedAt) return 'archived';
  return 'soft';
}

/**
 * Compute the canonical retention marks for a record being soft-deleted at
 * `deletedAt`, using the fixed §17.1 defaults:
 *   archive after {@link PLATFORM_CONSTANTS.RETENTION_SOFT_DELETE_DAYS} days,
 *   purge {@link PLATFORM_CONSTANTS.RETENTION_HARD_DELETE_AFTER_ARCHIVE_MONTHS}
 *   months after archival.
 */
export function computeRetentionMarks(deletedAt: Date = new Date()): Required<RetentionMarks> {
  const archivedAt = new Date(
    deletedAt.getTime() + PLATFORM_CONSTANTS.RETENTION_SOFT_DELETE_DAYS * DAY_MS,
  );
  const purgeAfter = addMonths(
    archivedAt,
    PLATFORM_CONSTANTS.RETENTION_HARD_DELETE_AFTER_ARCHIVE_MONTHS,
  );
  return { deletedAt, archivedAt, purgeAfter };
}

/** TTL (seconds) for the consumer dedup ledger / processed_events (FR-NFR-33). */
export function dedupTtlSeconds(): number {
  return Math.floor(PLATFORM_CONSTANTS.IDEMPOTENCY_DEDUP_TTL_MS / 1_000);
}
