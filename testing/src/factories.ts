import { uuidv7 } from 'uuidv7';

/**
 * Tiny deterministic-ish entity factory kit (QA-CI T-026).
 *
 * Domain-specific factories (a control Project, an orders Order, …) belong next
 * to that domain's tests, but they should be built on this kit so every factory
 * shares one override/merge contract and monotonic id generation. Keeps fixtures
 * terse: `makeProject({ name: 'X' })` instead of hand-rolling every field.
 */

let seq = 0;
/** Monotonically increasing counter — stable, readable ids inside one test run. */
export function nextSeq(): number {
  return ++seq;
}

/** Reset the sequence counter (call in beforeEach when a test asserts on ids). */
export function resetSeq(): void {
  seq = 0;
}

/** A time-ordered uuid (uuidv7) — same generator the domains use for entity ids. */
export function uuid(): string {
  return uuidv7();
}

/** A short, human-readable id with a prefix, e.g. `id('proj')` → `proj-1`. */
export function id(prefix = 'id'): string {
  return `${prefix}-${nextSeq()}`;
}

/** Fixed base instant so date assertions are stable unless a test overrides it. */
export const FIXED_NOW = new Date('2026-01-02T03:04:05.000Z');

export function nowIso(): string {
  return FIXED_NOW.toISOString();
}

export type Overrides<T> = Partial<T>;

/**
 * Create a factory from a defaults builder. The builder receives the running
 * sequence number so each produced entity can differ (unique ids/names).
 *
 * @example
 *   const makeMember = defineFactory<Member>((n) => ({
 *     id: `member-${n}`, userId: `user-${n}`, role: 'employee',
 *   }));
 *   makeMember();                      // role: 'employee'
 *   makeMember({ role: 'manager' });   // role: 'manager'
 */
export function defineFactory<T>(build: (n: number) => T): (overrides?: Overrides<T>) => T {
  return (overrides: Overrides<T> = {}) => ({ ...build(nextSeq()), ...overrides });
}
