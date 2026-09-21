/**
 * Gateway adapter for the shared donor manifests (documents contract §3.9).
 * Aggregation + module gating lives in `@fairflow/shared/document-variable-manifest`;
 * dynamic `order.field.*` keys are appended by the BFF when an order type is known.
 */
import {
  aggregateDocumentVariableManifest,
  type DocumentVariableManifestEntry,
  type DocumentVariableSource,
} from '@fairflow/shared';

export type DocVarSource = DocumentVariableSource;
export type DocVarContextType = 'order' | 'deal' | 'contact' | 'company';

export interface VariableDef {
  key: string;
  label: string;
  group: string;
  required: boolean;
  source: DocVarSource;
}

/** Valid `contextType` values (contract §3.9). */
export function isDocVarContextType(v: unknown): v is DocVarContextType {
  return v === 'order' || v === 'deal' || v === 'contact' || v === 'company';
}

function toVariableDef(entry: DocumentVariableManifestEntry): VariableDef {
  return {
    key: entry.key,
    label: entry.label,
    group: entry.group,
    required: entry.required,
    source: entry.source,
  };
}

/**
 * Static donor palette for a context (module-gated globals appended by shared).
 * Pass `enabledModules` to hide variables from disabled donors (FR-MDOC-24).
 */
export function documentVariablesCatalog(
  contextType: DocVarContextType,
  enabledModules?: readonly string[],
): VariableDef[] {
  return aggregateDocumentVariableManifest(contextType, enabledModules).map(toVariableDef);
}
