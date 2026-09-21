/**
 * Shared search tokenizer — single source for contact event `indexTokens` and the
 * search index (TODO-260 / NFR-CONTACTS-050). Keeps event-side pre-tokenization
 * aligned with {@link SearchService} / {@link ProjectionApply}.
 */

/** Characters kept in the base token string (letters/digits + `_ @ . + -`). */
const BASE_STRIP_RE = /[^a-z0-9а-яё_@.+-]+/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Minimal count of digits in a value for it to be treated as a phone number. */
const PHONE_MIN_DIGITS = 7;

/** Digit-tail lengths indexed for «поиск по последним цифрам». */
const PHONE_TAILS = [4, 7, 10];

function normalizedVariants(part: string): string[] {
  const out: string[] = [];
  const lower = part.toLowerCase();

  for (const email of lower.match(EMAIL_RE) ?? []) {
    out.push(email);
    const local = email.slice(0, email.indexOf('@'));
    if (local) out.push(local);
  }

  const digits = lower.replace(/\D+/g, '');
  if (digits.length >= PHONE_MIN_DIGITS) {
    out.push(digits);
    for (const tail of PHONE_TAILS) {
      if (digits.length > tail) out.push(digits.slice(-tail));
    }
  }
  return out;
}

/** Build the `tokens` / `indexTokens` field for search projection. */
export function buildSearchTokens(parts: Array<string | undefined | null>): string {
  const raw = parts.filter((p) => p != null && String(p) !== '').map((p) => String(p));
  const base = raw
    .join(' ')
    .toLowerCase()
    .replace(BASE_STRIP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const extra = new Set<string>();
  for (const part of raw) {
    for (const variant of normalizedVariants(part)) {
      if (variant && !base.includes(variant)) extra.add(variant);
    }
  }
  if (extra.size === 0) return base;
  return `${base} ${[...extra].join(' ')}`.trim();
}
