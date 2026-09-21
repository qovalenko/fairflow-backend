/**
 * Pure, I/O-free validation for order-type revision specs (FR-ORDERS-035 / FR-ORDERS-100).
 * Mirrors the execution gates in automation (webhook/email/task) and the documents
 * template registry — unit-testable without Nest/gRPC.
 */

export type SpecViolation = { field: string; reason: string };

/** `{{ contact.email }}` — resolved at send time, not a literal mailbox. */
const EMAIL_PLACEHOLDER = /^\{\{\s*[A-Za-z0-9_.-]+\s*\}\}$/;

/** Same strict single-mailbox gate as `email-executor` / OrderTypeForm (no lists/brackets). */
const SINGLE_MAILBOX =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function templateRefId(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const o = raw as Record<string, unknown>;
  return String(o.id ?? o.templateId ?? o.template_id ?? '').trim();
}

/** FR-ORDERS-100: structural checks on `documentTemplates` before registry resolve. */
export function collectDocumentTemplateSpecViolations(
  raw: unknown,
  violations: SpecViolation[],
): void {
  if (raw == null) return;
  if (!Array.isArray(raw)) {
    violations.push({ field: 'documentTemplates', reason: 'invalid_shape' });
    return;
  }
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const id = templateRefId(entry);
    if (!id) {
      violations.push({ field: `documentTemplates[${i}]`, reason: 'template_id_required' });
      return;
    }
    if (seen.has(id)) {
      violations.push({ field: `documentTemplates[${i}]`, reason: 'duplicate_template_id' });
      return;
    }
    seen.add(id);
  });
}

/**
 * FR-ORDERS-035: early validation of `finalActionSpec` on type save — shape mirrors
 * automation executors; existence of connection/assignee is checked asynchronously.
 */
export function collectFinalActionSpecViolations(raw: unknown, violations: SpecViolation[]): void {
  if (!raw || typeof raw !== 'object') return;
  const fa = raw as { type?: string; config?: Record<string, unknown> };
  const type = String(fa.type ?? 'none')
    .trim()
    .toLowerCase();
  const supported = new Set(['none', 'webhook', 'task', 'email']);
  if (!supported.has(type)) {
    violations.push({ field: 'finalActionSpec.type', reason: 'unsupported_action_type' });
    return;
  }
  const cfg = fa.config ?? {};
  if (type === 'webhook') {
    const connectionId = String(
      cfg.connection_id ?? cfg.connectionId ?? cfg.urlRef ?? cfg.url_ref ?? '',
    ).trim();
    const rawUrl = String(cfg.url ?? cfg.webhook_url ?? cfg.webhookUrl ?? '').trim();
    if (!connectionId) {
      violations.push({ field: 'finalActionSpec.config', reason: 'webhook_connection_required' });
    }
    if (rawUrl) {
      violations.push({ field: 'finalActionSpec.config', reason: 'raw_url_forbidden' });
    }
    return;
  }
  if (type === 'email') {
    const to = String(cfg.to ?? cfg.email ?? cfg.recipient ?? '').trim();
    if (!to) {
      violations.push({ field: 'finalActionSpec.config.to', reason: 'email_recipient_required' });
    } else if (!EMAIL_PLACEHOLDER.test(to) && !SINGLE_MAILBOX.test(to)) {
      violations.push({ field: 'finalActionSpec.config.to', reason: 'email_recipient_invalid' });
    }
    return;
  }
  if (type === 'task') {
    const title = String(cfg.title ?? '').trim();
    if (!title) {
      violations.push({ field: 'finalActionSpec.config.title', reason: 'task_title_required' });
    }
  }
}

/** Extract ids that need async registry/member checks after sync validation passes. */
export function extractFinalActionExistenceChecks(raw: unknown): {
  connectionId?: string;
  assigneeId?: string;
} {
  if (!raw || typeof raw !== 'object') return {};
  const fa = raw as { type?: string; config?: Record<string, unknown> };
  const type = String(fa.type ?? 'none')
    .trim()
    .toLowerCase();
  const cfg = fa.config ?? {};
  if (type === 'webhook') {
    const connectionId = String(
      cfg.connection_id ?? cfg.connectionId ?? cfg.urlRef ?? cfg.url_ref ?? '',
    ).trim();
    return connectionId ? { connectionId } : {};
  }
  if (type === 'task') {
    const assigneeId = String(
      cfg.userId ?? cfg.user_id ?? cfg.assigneeId ?? cfg.assignee_id ?? '',
    ).trim();
    return assigneeId ? { assigneeId } : {};
  }
  return {};
}

export function extractDocumentTemplateIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(templateRefId).filter(Boolean);
}
