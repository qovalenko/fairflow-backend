import { buildAbacGateSnapshot, type AbacGateSnapshot } from './abac/materialize';
import { evalGateRaw, type AbacNode } from './abac';

/** Sensitive company requisites masked on gateway projection (FR-COMPANIES-380 / FR-MCOM-38). */
export const COMPANY_SENSITIVE_REST_FIELDS = [
  'inn',
  'kpp',
  'ogrn',
  'bankName',
  'bik',
  'correspondentAccount',
  'settlementAccount',
] as const;

export type CompanySensitiveField = (typeof COMPANY_SENSITIVE_REST_FIELDS)[number];

const MASK = '***';

/** Mask sensitive requisites in a gateway company projection row. */
export function maskCompanySensitiveFields<T extends Record<string, unknown>>(
  row: T,
  reveal: boolean,
): T {
  if (reveal) return row;
  const out = { ...row } as Record<string, unknown>;
  for (const field of COMPANY_SENSITIVE_REST_FIELDS) {
    if (out[field] !== undefined && out[field] !== null && out[field] !== '') {
      out[field] = MASK;
    }
  }
  return out as T;
}

export type CompanyAccessPredicate = {
  present?: boolean;
  malformed?: boolean;
  ir?: AbacNode;
};

/**
 * Whether sensitive requisites may be shown for this company row.
 * Fail-closed: malformed predicate → hide; present IR that fails evalGate → hide.
 */
export function companySensitiveReveal(
  access: CompanyAccessPredicate | undefined,
  record: Record<string, unknown>,
): boolean {
  if (!access?.present) return true;
  if (access.malformed) return false;
  if (!access.ir) return true;
  const snapshot: AbacGateSnapshot = buildAbacGateSnapshot('companies', record);
  try {
    return evalGateRaw(access.ir, snapshot);
  } catch {
    return false;
  }
}
