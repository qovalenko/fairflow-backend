/**
 * documents-module: contextType ↔ moduleId mapping (TZ §5.8, B-1 resolution).
 *
 * Single source of truth for FR-MDOC-12/24/25/28: a document template/group is
 * bound to one CRM context type, and each context type maps to exactly one module
 * id in the registry (registry ids are plural: contacts/companies/deals/orders,
 * while contextType is singular). The donor that serves variables/snapshot for a
 * context is the same module.
 */

export const DOCUMENT_CONTEXT_TYPES = ['order', 'deal', 'contact', 'company'] as const;
export type DocumentContextType = (typeof DOCUMENT_CONTEXT_TYPES)[number];

/** Context types that may carry an upload without a CRM record. */
export const DOCUMENT_CONTEXT_TYPES_WITH_NONE = [...DOCUMENT_CONTEXT_TYPES, 'none'] as const;
export type DocumentContextTypeOrNone = (typeof DOCUMENT_CONTEXT_TYPES_WITH_NONE)[number];

/**
 * chat (M-CHAT-8, contracts/chat.md §3.17): `chat` is an UPLOAD-only context for
 * message attachments. It has no template/drift/variable donor (it is not in
 * DOCUMENT_CONTEXT_TYPES / DOCUMENT_CONTEXT_TO_MODULE), so it never flows through
 * template generation. Membership in the conversation (record_id=conversationId)
 * is enforced in two places (SEC-C-3): the gateway chat-BFF checks it on upload
 * (chat.GetConversation before storing bytes), and the documents domain checks it
 * on download (chat.IsConversationMember before presigning, fail-closed when chat
 * is unavailable). Template/group-from-template paths do not accept this context.
 * Keep this list as the upload allowed-set.
 */
export const DOCUMENT_UPLOAD_CONTEXT_TYPES = [...DOCUMENT_CONTEXT_TYPES, 'chat', 'none'] as const;
export type DocumentUploadContextType = (typeof DOCUMENT_UPLOAD_CONTEXT_TYPES)[number];

export function isDocumentUploadContextType(v: unknown): v is DocumentUploadContextType {
  return typeof v === 'string' && (DOCUMENT_UPLOAD_CONTEXT_TYPES as readonly string[]).includes(v);
}

/** contextType → registry moduleId (donor of variables/snapshot). */
export const DOCUMENT_CONTEXT_TO_MODULE: Record<DocumentContextType, string> = {
  order: 'orders',
  deal: 'deals',
  contact: 'contacts',
  company: 'companies',
};

export function isDocumentContextType(v: unknown): v is DocumentContextType {
  return typeof v === 'string' && (DOCUMENT_CONTEXT_TYPES as readonly string[]).includes(v);
}

export function isDocumentContextTypeOrNone(v: unknown): v is DocumentContextTypeOrNone {
  return (
    typeof v === 'string' && (DOCUMENT_CONTEXT_TYPES_WITH_NONE as readonly string[]).includes(v)
  );
}

/** Module id that serves variables/snapshot for a context type (null for none). */
export function documentContextModuleId(
  contextType: DocumentContextTypeOrNone,
): string | null {
  return contextType === 'none'
    ? null
    : DOCUMENT_CONTEXT_TO_MODULE[contextType as DocumentContextType];
}

export const TEMPLATE_STATUSES = ['draft', 'published', 'archived'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const DOCUMENT_GENERATED_VIA = ['manual', 'regenerate', 'automation', 'upload'] as const;
export type DocumentGeneratedVia = (typeof DOCUMENT_GENERATED_VIA)[number];
