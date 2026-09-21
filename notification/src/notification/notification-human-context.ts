/**
 * Best-effort human labels from event payloads (FR-NOTIF-215 partial).
 * Full `humanContext` dictionary is deferred to OQ-NOTIF-010; source domains
 * already ship flat `name` / `*Name` fields on some facts.
 */
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

const NAMED_KEYS = ['name', 'dealName', 'orderName', 'contactName', 'companyName'] as const;

/** Prefer a human label from the payload; fall back to the first present id field. */
export function payloadEntityLabel(
  payload: Record<string, unknown>,
  idKeys: readonly string[],
): string {
  for (const key of NAMED_KEYS) {
    const label = str(payload[key]).trim();
    if (label) return label;
  }
  const hc = payload.humanContext;
  if (hc && typeof hc === 'object' && !Array.isArray(hc)) {
    const fromCtx = str((hc as Record<string, unknown>).displayName).trim();
    if (fromCtx) return fromCtx;
  }
  for (const key of idKeys) {
    const id = str(payload[key]).trim();
    if (id) return id;
  }
  return '';
}

export function quotedLabel(label: string): string {
  return label ? `«${label}»` : '';
}
