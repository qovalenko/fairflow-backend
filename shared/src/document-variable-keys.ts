import {
  DOCUMENT_CONTEXT_TO_MODULE,
  type DocumentContextType,
} from './document-context';

/**
 * Canonical globals available in every template context (FR-MDOC-24).
 * `today.iso` is not advertised in the palette but IS injected by the domain
 * renderer (`withServiceVariables`), so templates may legally reference it.
 */
export const DOCUMENT_GLOBAL_VARIABLE_KEYS = [
  'project.name',
  'today',
  'today.iso',
  'today.year',
  'now',
] as const;

/**
 * Custom order-type fields are resolved by the orders donor as dynamic
 * `order.field.<key>` variables (orders.service `buildOrderDocumentVariables`);
 * a fixed allow-list cannot enumerate them, so the order context accepts the
 * whole prefix (non-empty suffix required).
 */
const ORDER_FIELD_PREFIX = 'order.field.';

/** Keys mirrored from gateway `document-variables-catalog.ts` for FR-DOCS-080. */
const BY_CONTEXT: Record<DocumentContextType, readonly string[]> = {
  order: [
    'order.number',
    'order.typeName',
    'order.stage',
    'order.status',
    'deal.name',
    'contact.name',
    'company.name',
  ],
  deal: [
    'deal.name',
    'deal.amount',
    'deal.currency',
    'deal.stage',
    'deal.status',
    'deal.probability',
    'deal.source',
    'contact.name',
    'contact.phone',
    'contact.email',
    'company.name',
  ],
  contact: [
    'contact.name',
    'contact.fullName',
    'contact.firstName',
    'contact.lastName',
    'contact.middleName',
    'contact.phone',
    'contact.email',
    'contact.position',
  ],
  company: [
    'company.name',
    'company.inn',
    'company.kpp',
    'company.ogrn',
    'company.legalAddress',
    'company.phone',
    'company.email',
    'company.website',
    'company.industry',
    'company.region',
  ],
};

/** Allowed placeholder keys for a template context (catalog + globals, FR-DOCS-080). */
export function allowedDocumentVariableKeys(
  contextType: DocumentContextType,
): ReadonlySet<string> {
  return new Set([...BY_CONTEXT[contextType], ...DOCUMENT_GLOBAL_VARIABLE_KEYS]);
}

/** Registry module id that owns a variable key (null for globals / unknown prefix). */
export function documentVariableSourceModuleId(key: string): string | null {
  if (!key || DOCUMENT_GLOBAL_VARIABLE_KEYS.includes(key as (typeof DOCUMENT_GLOBAL_VARIABLE_KEYS)[number])) {
    return null;
  }
  const prefix = key.split('.')[0];
  const map: Record<string, string> = {
    order: DOCUMENT_CONTEXT_TO_MODULE.order,
    deal: DOCUMENT_CONTEXT_TO_MODULE.deal,
    contact: DOCUMENT_CONTEXT_TO_MODULE.contact,
    company: DOCUMENT_CONTEXT_TO_MODULE.company,
  };
  return map[prefix] ?? null;
}

/**
 * Fail-closed validation of declared/extracted template variables.
 * When `enabledModules` is provided, variables whose source module is disabled
 * are rejected (FR-DOCS-080 — catalog ∩ effective modules).
 */
export function findUnknownDocumentVariableKeys(
  contextType: DocumentContextType,
  keys: readonly string[],
  enabledModules?: readonly string[],
): string[] {
  const allowed = allowedDocumentVariableKeys(contextType);
  const modulesKnown = Array.isArray(enabledModules);
  return keys.filter((k) => {
    if (!k) return false;
    if (allowed.has(k)) {
      if (!modulesKnown) return false;
      const sourceModule = documentVariableSourceModuleId(k);
      if (!sourceModule) return false;
      return !enabledModules.includes(sourceModule);
    }
    if (contextType === 'order' && k.startsWith(ORDER_FIELD_PREFIX) && k.length > ORDER_FIELD_PREFIX.length) {
      if (!modulesKnown) return false;
      return !enabledModules.includes(DOCUMENT_CONTEXT_TO_MODULE.order);
    }
    return true;
  });
}
