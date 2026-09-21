// Локальный shared: symlink node_modules/@fairflow/shared указывает на чужой
// worktree без search-tokens — относительный импорт гарантирует NFR-CONTACTS-050.
import { buildSearchTokens } from '@fairflow/shared';

function maskEmail(email?: string | null): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return `${email[0] ?? ''}***`;
  return `${local[0] ?? ''}***@${domain}`;
}

function maskPhone(phone?: string | null): string {
  if (!phone) return '';
  const tail = phone.slice(-4);
  return `+***${tail}`;
}

/** Input for `crm.contact.created` emit (S14-minimized, no raw email/phone). */
export interface ContactCreatedEmitInput {
  contactId: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  companyIds?: string[];
  ownerId?: string | null;
  departmentId?: string | null;
}

/**
 * NFR-CONTACTS-050 / S14: raw email/phone stay in Mongo, not on the event bus.
 * Search gets pre-computed `indexTokens` + masked `subtitle` instead.
 */
export function buildContactCreatedEventPayload(
  input: ContactCreatedEmitInput,
): Record<string, unknown> {
  const fullName = `${input.firstName ?? ''} ${input.lastName ?? ''}`.trim();
  const subtitleParts = [maskEmail(input.email), maskPhone(input.phone)].filter(Boolean);
  const payload: Record<string, unknown> = {
    contactId: input.contactId,
    firstName: input.firstName,
    lastName: input.lastName,
    companyIds: input.companyIds ?? [],
    ownerId: input.ownerId,
    departmentId: input.departmentId ?? null,
  };
  if (subtitleParts.length) payload.subtitle = subtitleParts.join(' · ');
  const indexTokens = buildSearchTokens([fullName, input.email, input.phone]);
  if (indexTokens) payload.indexTokens = indexTokens;
  return payload;
}
