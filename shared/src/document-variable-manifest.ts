/**
 * Donor module manifests for the document-variable palette (FR-DOCS-310 / FR-MDOC-24).
 * Each CRM module that resolves `ResolveDocumentVariables` registers its keys here;
 * the gateway aggregates manifests filtered by `effectiveModules`.
 */
import { DOCUMENT_CONTEXT_TO_MODULE, type DocumentContextType } from './document-context';

export type DocumentVariableSource = 'order' | 'deal' | 'contact' | 'company' | 'global';

export interface DocumentVariableManifestEntry {
  key: string;
  label: string;
  group: string;
  required: boolean;
  source: DocumentVariableSource;
}

const GROUP = {
  order: 'Продажа',
  deal: 'Сделка',
  contact: 'Контакт',
  company: 'Компания',
  global: 'Глобальные',
} as const;

const GLOBAL_MANIFEST: DocumentVariableManifestEntry[] = [
  { key: 'project.name', label: 'Проект', group: GROUP.global, required: false, source: 'global' },
  { key: 'today', label: 'Дата', group: GROUP.global, required: false, source: 'global' },
  { key: 'today.year', label: 'Год', group: GROUP.global, required: false, source: 'global' },
  { key: 'now', label: 'Дата и время', group: GROUP.global, required: false, source: 'global' },
];

const ORDER_MANIFEST: DocumentVariableManifestEntry[] = [
  { key: 'order.number', label: 'Номер продажи', group: GROUP.order, required: true, source: 'order' },
  { key: 'order.typeName', label: 'Тип продажи', group: GROUP.order, required: false, source: 'order' },
  { key: 'order.stage', label: 'Стадия', group: GROUP.order, required: false, source: 'order' },
  { key: 'order.status', label: 'Статус', group: GROUP.order, required: false, source: 'order' },
  { key: 'deal.name', label: 'Сделка', group: GROUP.deal, required: false, source: 'deal' },
  { key: 'contact.name', label: 'Контакт', group: GROUP.contact, required: false, source: 'contact' },
  { key: 'company.name', label: 'Компания', group: GROUP.company, required: false, source: 'company' },
];

const DEAL_MANIFEST: DocumentVariableManifestEntry[] = [
  { key: 'deal.name', label: 'Название сделки', group: GROUP.deal, required: true, source: 'deal' },
  { key: 'deal.amount', label: 'Сумма', group: GROUP.deal, required: false, source: 'deal' },
  { key: 'deal.currency', label: 'Валюта', group: GROUP.deal, required: false, source: 'deal' },
  { key: 'deal.stage', label: 'Стадия', group: GROUP.deal, required: false, source: 'deal' },
  { key: 'deal.status', label: 'Статус', group: GROUP.deal, required: false, source: 'deal' },
  { key: 'deal.probability', label: 'Вероятность', group: GROUP.deal, required: false, source: 'deal' },
  { key: 'deal.source', label: 'Источник', group: GROUP.deal, required: false, source: 'deal' },
  { key: 'contact.name', label: 'Контакт', group: GROUP.contact, required: false, source: 'contact' },
  { key: 'contact.phone', label: 'Телефон контакта', group: GROUP.contact, required: false, source: 'contact' },
  { key: 'contact.email', label: 'Email контакта', group: GROUP.contact, required: false, source: 'contact' },
  { key: 'company.name', label: 'Компания', group: GROUP.company, required: false, source: 'company' },
];

const CONTACT_MANIFEST: DocumentVariableManifestEntry[] = [
  { key: 'contact.name', label: 'Имя и фамилия', group: GROUP.contact, required: true, source: 'contact' },
  { key: 'contact.fullName', label: 'ФИО', group: GROUP.contact, required: false, source: 'contact' },
  { key: 'contact.firstName', label: 'Имя', group: GROUP.contact, required: false, source: 'contact' },
  { key: 'contact.lastName', label: 'Фамилия', group: GROUP.contact, required: false, source: 'contact' },
  { key: 'contact.middleName', label: 'Отчество', group: GROUP.contact, required: false, source: 'contact' },
  { key: 'contact.phone', label: 'Телефон', group: GROUP.contact, required: false, source: 'contact' },
  { key: 'contact.email', label: 'Email', group: GROUP.contact, required: false, source: 'contact' },
  { key: 'contact.position', label: 'Должность', group: GROUP.contact, required: false, source: 'contact' },
];

const COMPANY_MANIFEST: DocumentVariableManifestEntry[] = [
  { key: 'company.name', label: 'Название', group: GROUP.company, required: true, source: 'company' },
  { key: 'company.inn', label: 'ИНН', group: GROUP.company, required: true, source: 'company' },
  { key: 'company.kpp', label: 'КПП', group: GROUP.company, required: false, source: 'company' },
  { key: 'company.ogrn', label: 'ОГРН', group: GROUP.company, required: false, source: 'company' },
  { key: 'company.legalAddress', label: 'Юридический адрес', group: GROUP.company, required: false, source: 'company' },
  { key: 'company.phone', label: 'Телефон', group: GROUP.company, required: false, source: 'company' },
  { key: 'company.email', label: 'Email', group: GROUP.company, required: false, source: 'company' },
  { key: 'company.website', label: 'Сайт', group: GROUP.company, required: false, source: 'company' },
  { key: 'company.industry', label: 'Отрасль', group: GROUP.company, required: false, source: 'company' },
  { key: 'company.region', label: 'Регион', group: GROUP.company, required: false, source: 'company' },
];

/** Per-context donor manifests (globals are appended by the aggregator). */
export const DOCUMENT_VARIABLE_MANIFESTS: Record<
  DocumentContextType,
  DocumentVariableManifestEntry[]
> = {
  order: ORDER_MANIFEST,
  deal: DEAL_MANIFEST,
  contact: CONTACT_MANIFEST,
  company: COMPANY_MANIFEST,
};

/** Canonical globals available in every context. */
export const DOCUMENT_GLOBAL_VARIABLE_MANIFEST = GLOBAL_MANIFEST;

/** Map a variable `source` to the RBAC module id that must be enabled. */
export function documentVariableManifestModuleId(source: DocumentVariableSource): string | null {
  if (source === 'global') return null;
  return DOCUMENT_CONTEXT_TO_MODULE[source];
}

/**
 * Palette for a context: donor manifest entries (module-gated by caller) + globals.
 */
export function aggregateDocumentVariableManifest(
  contextType: DocumentContextType,
  enabledModules?: readonly string[],
): DocumentVariableManifestEntry[] {
  const donor = DOCUMENT_VARIABLE_MANIFESTS[contextType];
  const modulesKnown = Array.isArray(enabledModules);
  const gated = modulesKnown
    ? donor.filter((item) => {
        const moduleId = documentVariableManifestModuleId(item.source);
        if (!moduleId) return true;
        return enabledModules.includes(moduleId);
      })
    : donor;
  return [...gated, ...DOCUMENT_GLOBAL_VARIABLE_MANIFEST];
}
