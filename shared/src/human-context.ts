/**
 * Canonical `humanContext` block for CRM notification payloads (FR-NOTIF-215).
 * Emitters SHOULD populate this; the notification consumer may synthesize it from
 * legacy flat `name` / `*Name` fields when absent.
 */
export type HumanContext = {
  displayName: string;
  amount?: string;
  actorName?: string;
};

const NAMED_KEYS = ['name', 'dealName', 'orderName', 'contactName', 'companyName'] as const;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Build or merge humanContext from a flat event payload. */
export function buildHumanContext(
  payload: Record<string, unknown>,
  idKeys: readonly string[] = ['dealId', 'orderId', 'contactId', 'companyId'],
): HumanContext {
  const existing = payload.humanContext;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const hc = existing as Record<string, unknown>;
    const displayName = str(hc.displayName).trim();
    if (displayName) {
      return {
        displayName,
        amount: str(hc.amount).trim() || undefined,
        actorName: str(hc.actorName).trim() || undefined,
      };
    }
  }
  let displayName = '';
  for (const key of NAMED_KEYS) {
    displayName = str(payload[key]).trim();
    if (displayName) break;
  }
  if (!displayName) {
    for (const key of idKeys) {
      displayName = str(payload[key]).trim();
      if (displayName) break;
    }
  }
  const amountRaw = payload.amount ?? payload.dealAmount ?? payload.orderAmount;
  const amount =
    amountRaw != null && String(amountRaw).trim() !== '' ? String(amountRaw).trim() : undefined;
  const actorName =
    str(payload.actorName ?? payload.movedByName ?? payload.actorUserName).trim() || undefined;
  return { displayName, amount, actorName };
}
