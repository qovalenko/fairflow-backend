/** Extract entity ref from an event/trigger payload for execution journaling. */
export function entityRefFromPayload(
  payload: Record<string, unknown>,
  triggerEntityType?: string,
): { entity_type: string; entity_id: string } {
  const kind = String(
    payload.entity_type ?? payload.entityType ?? triggerEntityType ?? '',
  ).trim();
  const idKeys = [
    'entity_id',
    'entityId',
    `${kind}_id`,
    `${kind}Id`,
    'id',
    'deal_id',
    'dealId',
    'contact_id',
    'contactId',
    'order_id',
    'orderId',
    'company_id',
    'companyId',
    'activity_id',
    'activityId',
  ];
  for (const k of idKeys) {
    const v = payload[k];
    if (v != null && String(v).trim()) {
      return { entity_type: kind || inferKindFromKey(k), entity_id: String(v).trim() };
    }
  }
  return { entity_type: kind, entity_id: '' };
}

function inferKindFromKey(key: string): string {
  if (key.endsWith('_id') || key.endsWith('Id')) {
    return key.replace(/_id$/, '').replace(/Id$/, '');
  }
  return '';
}
