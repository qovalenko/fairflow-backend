/**
 * Anti-SSRF webhook-target validation (shared across services).
 *
 * Outbound webhooks are the only user-controlled URL sink in the platform, so
 * URL validation is a mandatory security gate, not optional. It guards both the
 * automation `automation_connections` sink (contract §3.15, FR-MAUT-29) and the
 * control project-integration REST endpoints (box outbound webhooks). Keeping a
 * single copy here prevents the two deny-lists from drifting apart. We block:
 *   - schemes other than https
 *   - loopback / RFC1918 / link-local / unique-local IP literals
 *   - the cloud metadata endpoint 169.254.169.254
 *   - internal hostnames (.internal / .local / .lan / *.ts.net), plus any
 *     suffix listed in WEBHOOK_INTERNAL_SUFFIXES (private deployments add their
 *     own internal TLD there — it is enforced exactly like the built-ins)
 *
 * IMPORTANT (host canonicalization): a raw host is classified through a
 * canonical parser BEFORE the deny-list runs. The OS resolver (getaddrinfo /
 * inet_aton) accepts obfuscated numeric literals — short (`127.1`), decimal
 * (`2130706433`), octal (`0177.0.0.1`) and hex (`0x7f.1`) forms, plus
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) — and collapses them to the real
 * address at connect time. A naive dotted-quad regex is blind to all of these,
 * so an attacker could smuggle a loopback/metadata target past the check. We
 * therefore normalize every numeric-looking host to its canonical address and
 * classify THAT; a purely-numeric host we cannot canonicalize is rejected
 * outright rather than trusted as a hostname.
 *
 * NOTE (TOCTOU / DNS-rebinding): {@link validateWebhookTarget} checks the URL as
 * written. Callers that actually dispatch must ALSO re-resolve and re-check the
 * IP at *send* time via {@link assertResolvedTargetAllowed} — the host may
 * re-point at a private/metadata IP after the target was persisted.
 */

import { isIP } from 'node:net';

export type WebhookTargetReason =
  | 'scheme'
  | 'private_ip'
  | 'loopback'
  | 'link_local'
  | 'metadata'
  | 'internal_host'
  | 'malformed';

export interface WebhookTargetVerdict {
  ok: boolean;
  reason?: WebhookTargetReason;
}

/** Classify a CANONICAL dotted-quad IPv4 string against the deny-list. */
function isPrivateIpv4(host: string): WebhookTargetReason | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[3]), Number(m[4])].some((n) => n > 255) || b > 255) return 'malformed';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private_ip';
  if (a === 172 && b >= 16 && b <= 31) return 'private_ip';
  if (a === 192 && b === 168) return 'private_ip';
  if (a === 169 && b === 254) {
    return host === '169.254.169.254' ? 'metadata' : 'link_local';
  }
  if (a === 0) return 'private_ip';
  return null;
}

/**
 * Canonicalize an obfuscated numeric IPv4 literal (inet_aton semantics) to a
 * dotted-quad string. Handles decimal/octal/hex parts and the short forms the
 * OS resolver accepts (`127.1`, `2130706433`, `0177.0.0.1`, `0x7f.1`).
 *
 * Returns:
 *   - a dotted-quad string when the host is a parseable numeric literal;
 *   - `'invalid'` when the host LOOKS numeric but is out of range / malformed —
 *     the caller must reject it (never hand it to DNS as a hostname);
 *   - `null` when the host is not numeric at all (a genuine hostname).
 */
function parseNumericIpv4(host: string): string | 'invalid' | null {
  // Purely-numeric parts only: decimal, octal (leading 0) or hex (0x…).
  if (!/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(host)) return null;
  const parts = host.split('.');
  if (parts.length > 4) return 'invalid';
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) {
      n = parseInt(p.slice(2), 16);
    } else if (/^0[0-7]+$/.test(p)) {
      n = parseInt(p, 8);
    } else if (/^\d+$/.test(p)) {
      // Leading-zero decimal that is not valid octal (e.g. `08`) is ambiguous.
      if (p.length > 1 && p[0] === '0') return 'invalid';
      n = parseInt(p, 10);
    } else {
      return 'invalid';
    }
    if (!Number.isSafeInteger(n) || n < 0) return 'invalid';
    nums.push(n);
  }
  // inet_aton: the final part is a big-endian remainder covering the missing
  // low bytes (so `a.b` → a.0.0.b-as-24-bit, `a` → 32-bit).
  const last = nums.length - 1;
  const maxLast = Math.pow(256, 4 - last) - 1;
  if (nums[last] > maxLast) return 'invalid';
  for (let i = 0; i < last; i++) if (nums[i] > 255) return 'invalid';
  let value = nums[last];
  for (let i = 0; i < last; i++) value += nums[i] * Math.pow(256, 3 - i);
  if (value > 0xffffffff) return 'invalid';
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

/** Expand a valid IPv6 literal (brackets stripped) into 8 16-bit words. */
function ipv6Words(host: string): number[] | null {
  if (isIP(host) !== 6) return null;
  let s = host;
  // Convert an embedded dotted-IPv4 tail (`::ffff:127.0.0.1`) into two hextets.
  const di = s.lastIndexOf(':');
  const tail = s.slice(di + 1);
  if (tail.includes('.')) {
    const q = tail.split('.').map((x) => Number(x));
    if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, di + 1)}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tailGroups = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const words: number[] = [];
  for (const g of head) words.push(parseInt(g, 16));
  if (halves.length === 2) {
    const fill = 8 - head.length - tailGroups.length;
    if (fill < 0) return null;
    for (let i = 0; i < fill; i++) words.push(0);
  }
  for (const g of tailGroups) words.push(parseInt(g, 16));
  if (words.length !== 8 || words.some((w) => !Number.isFinite(w) || w < 0 || w > 0xffff)) return null;
  return words;
}

/** Classify a valid IPv6 literal against the deny-list (incl. mapped IPv4). */
function classifyIpv6(host: string): WebhookTargetReason | null {
  const w = ipv6Words(host);
  if (!w) return null;
  // IPv4-mapped (::ffff:a.b.c.d) or deprecated IPv4-compatible (::a.b.c.d):
  // the OS routes these to the embedded IPv4 — classify by that address.
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && (w[5] === 0xffff || w[5] === 0)) {
    if (w[5] === 0) {
      if (w[6] === 0 && w[7] === 0) return 'loopback'; // :: unspecified — deny
      if (w[6] === 0 && w[7] === 1) return 'loopback'; // ::1 loopback
    }
    const v4 = `${(w[6] >> 8) & 0xff}.${w[6] & 0xff}.${(w[7] >> 8) & 0xff}.${w[7] & 0xff}`;
    return isPrivateIpv4(v4);
  }
  if ((w[0] & 0xfe00) === 0xfc00) return 'private_ip'; // fc00::/7 unique-local
  if ((w[0] & 0xffc0) === 0xfe80) return 'link_local'; // fe80::/10 link-local
  return null;
}

/**
 * Extra internal suffixes for a private deployment, comma-separated:
 * `WEBHOOK_INTERNAL_SUFFIXES=.corp,.svc`. Deployments with their own internal
 * TLD MUST set this — otherwise webhooks may target it.
 */
const EXTRA_INTERNAL_SUFFIXES: readonly string[] = (
  process.env.WEBHOOK_INTERNAL_SUFFIXES ?? ''
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (EXTRA_INTERNAL_SUFFIXES.some((suffix) => h.endsWith(suffix))) return true;
  return (
    h.endsWith('.internal') ||
    h.endsWith('.local') ||
    h.endsWith('.ts.net') ||
    h.endsWith('.lan')
  );
}

/**
 * Classify a raw IP literal (v4/v6, canonical or obfuscated-numeric) against the
 * deny-list. Used by the send-time DNS re-check on already-resolved addresses,
 * and shared with the static validator. Returns a reason to DENY, or null to
 * allow. A numeric-looking-but-unparseable host is rejected as `malformed`.
 */
export function classifyResolvedIp(host: string): WebhookTargetReason | null {
  if (host.includes(':')) return classifyIpv6(host);
  if (isIP(host) === 4) return isPrivateIpv4(host);
  const numeric = parseNumericIpv4(host);
  if (numeric === 'invalid') return 'malformed';
  if (numeric) return isPrivateIpv4(numeric);
  return null;
}

/** Classify a URL host (IP literal or hostname) against the full deny-list. */
function classifyHost(host: string): WebhookTargetReason | null {
  if (!host) return 'malformed';
  if (host.includes(':')) {
    if (isIP(host) !== 6) return 'malformed';
    return classifyIpv6(host);
  }
  if (isIP(host) === 4) return isPrivateIpv4(host);
  const numeric = parseNumericIpv4(host);
  if (numeric === 'invalid') return 'malformed';
  if (numeric) return isPrivateIpv4(numeric);
  // Genuine hostname.
  return isInternalHost(host) ? 'internal_host' : null;
}

/**
 * Send-time DNS re-check (contract §3.15 TOCTOU / DNS-rebinding). Resolves the
 * host and rejects if ANY resolved address falls in the deny-list — the URL may
 * have re-pointed at a private/metadata IP after the connection was created.
 * IP literals (canonical, IPv6 or obfuscated-numeric) are classified directly
 * and never handed to DNS.
 */
export async function assertResolvedTargetAllowed(rawUrl: string): Promise<WebhookTargetVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // IP literal in any form — classify directly, do not resolve.
  if (host.includes(':') || isIP(host) === 4 || parseNumericIpv4(host) !== null) {
    const r = classifyResolvedIp(host);
    return r ? { ok: false, reason: r } : { ok: true };
  }
  try {
    const { lookup } = await import('node:dns/promises');
    const addrs = await lookup(host, { all: true });
    for (const a of addrs) {
      const r = classifyResolvedIp(a.address);
      if (r) return { ok: false, reason: r };
    }
  } catch {
    // Resolution failure is a transient send error, not a policy violation —
    // surfaced as a webhook delivery failure (DLQ), not WEBHOOK_TARGET_INVALID.
    return { ok: true };
  }
  return { ok: true };
}

/** Validate a connection URL against the SSRF deny-list. */
export function validateWebhookTarget(rawUrl: string): WebhookTargetVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' };

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const reason = classifyHost(host);
  return reason ? { ok: false, reason } : { ok: true };
}
