import type { CompanyLink } from '../mongo/mongo.service';

/** Sync `companyIds` projection from rich `companyLinks` metadata (FR-CONTACTS-320). */
export function companyIdsFromLinks(links: CompanyLink[] | undefined): string[] {
  if (!links?.length) return [];
  const ids = links.map((l) => l.companyId).filter((id) => typeof id === 'string' && id !== '');
  return [...new Set(ids)];
}

export function normalizeCompanyLinks(
  links: CompanyLink[] | undefined,
  legacyIds?: string[],
): CompanyLink[] {
  if (links?.length) {
    return links
      .filter((l) => l?.companyId)
      .map((l) => ({
        companyId: String(l.companyId),
        role: l.role?.trim() || undefined,
        isPrimary: l.isPrimary === true,
        position: l.position?.trim() || undefined,
        period:
          l.period && (l.period.from || l.period.to)
            ? {
                from: l.period.from ? Number(l.period.from) : undefined,
                to: l.period.to ? Number(l.period.to) : undefined,
              }
            : undefined,
      }));
  }
  if (legacyIds?.length) {
    return legacyIds.filter(Boolean).map((companyId, i) => ({
      companyId,
      isPrimary: i === 0,
    }));
  }
  return [];
}

export function companyLinksToProto(links: CompanyLink[] | undefined) {
  return (links ?? []).map((l) => ({
    company_id: l.companyId,
    role: l.role ?? '',
    is_primary: l.isPrimary === true,
    position: l.position ?? '',
    period: l.period ? { from: l.period.from ?? 0, to: l.period.to ?? 0 } : undefined,
  }));
}

export function companyLinksFromProto(
  links:
    | Array<{
        company_id?: string;
        companyId?: string;
        role?: string;
        is_primary?: boolean;
        isPrimary?: boolean;
        position?: string;
        period?: { from?: number; to?: number };
      }>
    | undefined,
): CompanyLink[] {
  if (!links?.length) return [];
  return normalizeCompanyLinks(
    links.map((l) => ({
      companyId: String(l.company_id ?? l.companyId ?? ''),
      role: l.role,
      isPrimary: l.is_primary === true || l.isPrimary === true,
      position: l.position,
      period: l.period,
    })),
  );
}

/** FR-COMPANIES-140: remap loser→master on M2M company refs (dedupe, preserve link metadata). */
export function remapCompanyRefs(
  loserId: string,
  masterId: string,
  companyIds: string[] | undefined,
  companyLinks: CompanyLink[] | undefined,
  orphanedCompanyIds: string[] | undefined,
): {
  companyIds: string[];
  companyLinks: CompanyLink[];
  orphanedCompanyIds: string[];
  changed: boolean;
} {
  const loser = (loserId ?? '').trim();
  const master = (masterId ?? '').trim();
  if (!loser || !master || loser === master) {
    return {
      companyIds: companyIds ?? [],
      companyLinks: companyLinks ?? [],
      orphanedCompanyIds: orphanedCompanyIds ?? [],
      changed: false,
    };
  }
  const hadLoser =
    (companyIds ?? []).includes(loser) ||
    (companyLinks ?? []).some((l) => l.companyId === loser) ||
    (orphanedCompanyIds ?? []).includes(loser);
  if (!hadLoser) {
    return {
      companyIds: companyIds ?? [],
      companyLinks: companyLinks ?? [],
      orphanedCompanyIds: orphanedCompanyIds ?? [],
      changed: false,
    };
  }
  const nextIds = [...new Set((companyIds ?? []).map((id) => (id === loser ? master : id)))];
  const remappedLinks = (companyLinks ?? []).map((l) =>
    l.companyId === loser ? { ...l, companyId: master } : l,
  );
  const seen = new Set<string>();
  const nextLinks = remappedLinks.filter((l) => {
    if (seen.has(l.companyId)) return false;
    seen.add(l.companyId);
    return true;
  });
  const nextOrphaned = [...new Set((orphanedCompanyIds ?? []).filter((id) => id !== loser))];
  return {
    companyIds: nextIds,
    companyLinks: nextLinks,
    orphanedCompanyIds: nextOrphaned,
    changed: true,
  };
}
