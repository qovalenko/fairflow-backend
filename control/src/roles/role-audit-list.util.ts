import type { Prisma } from '../generated/prisma';

export interface ListRoleAuditOpts {
  projectId: string;
  limit?: number;
  cursor?: string;
  filterActorUserId?: string;
  filterEntityType?: string;
  filterEntityId?: string;
  fromTs?: Date;
  toTs?: Date;
}

export function encodeRoleAuditCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

export function parseRoleAuditCursor(cursor: string): { createdAt: Date; id: string } | null {
  const raw = (cursor ?? '').trim();
  const sep = raw.indexOf('|');
  if (sep <= 0) return null;
  const createdAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!id || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

/** Build a Prisma where-clause for FR-ACCESS-610 list filters + cursor. */
export function buildRoleAuditWhere(opts: ListRoleAuditOpts): Prisma.RoleAuditLogWhereInput {
  const where: Prisma.RoleAuditLogWhereInput = { projectId: opts.projectId };
  const actor = (opts.filterActorUserId ?? '').trim();
  const entityType = (opts.filterEntityType ?? '').trim();
  const entityId = (opts.filterEntityId ?? '').trim();
  if (actor) where.actorUserId = actor;
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (opts.fromTs || opts.toTs) {
    where.createdAt = {
      ...(opts.fromTs ? { gte: opts.fromTs } : {}),
      ...(opts.toTs ? { lte: opts.toTs } : {}),
    };
  }
  if (opts.cursor) {
    const parsed = parseRoleAuditCursor(opts.cursor);
    if (parsed) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { createdAt: { lt: parsed.createdAt } },
            { createdAt: parsed.createdAt, id: { lt: parsed.id } },
          ],
        },
      ];
    }
  }
  return where;
}

/** Diff permission key arrays from role-audit before/after payloads (FR-ACCESS-640). */
export function diffPermissionKeySets(
  before: unknown,
  after: unknown,
): { added: string[]; removed: string[] } | null {
  const b = extractPermissionKeys(before);
  const a = extractPermissionKeys(after);
  if (!b && !a) return null;
  const beforeSet = new Set(b ?? []);
  const afterSet = new Set(a ?? []);
  const added = [...afterSet].filter((k) => !beforeSet.has(k)).sort();
  const removed = [...beforeSet].filter((k) => !afterSet.has(k)).sort();
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}

function extractPermissionKeys(payload: unknown): string[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const perms = (payload as { permissions?: unknown }).permissions;
  if (!Array.isArray(perms)) return null;
  return perms.map((p) => String(p)).filter(Boolean);
}
