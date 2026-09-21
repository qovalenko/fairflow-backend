/**
 * FR-ACCESS-490 / FR-ABAC-16: record owner always sees their own row even when an
 * ABAC deny rule would exclude it. Expressed as an OR with the owner field at the
 * Mongo predicate layer (guard push-down + domain composeAccessFilter).
 */
export function withRecordOwnerAbacShortCircuit(
  abac: Record<string, unknown> | null | undefined,
  ownerField: string,
  selfId: string | undefined | null,
): Record<string, unknown> | null {
  if (!abac) return abac ?? null;
  if (!ownerField || !selfId) return abac;
  return { $or: [abac, { [ownerField]: selfId }] };
}
