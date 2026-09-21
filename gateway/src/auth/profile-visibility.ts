/**
 * §19 visibility matrix for foreign-profile projection (FR-MPROF-25).
 * Must stay in sync with auth ProfileService.resolveVisibilityLevel.
 */
export function resolveProfileVisibilityLevel(projectRole?: string, platformRole?: string): number {
  if (platformRole === 'platform_owner' || platformRole === 'platform_admin') return 3;
  switch ((projectRole ?? '').toLowerCase()) {
    case 'owner':
    case 'project_admin':
    case 'admin':
      return 2;
    case 'member':
    case 'manager':
      return 1;
    default:
      return 0;
  }
}

/** Human-readable visibility label for «Мои доступы» (FR-PROFILE-280 / OQ-UX-MPROF-12). */
export const VISIBILITY_LEVEL_LABELS_RU: Record<string, string> = {
  only_own: 'Видишь сделки: только свои',
  own_and_shared: 'Видишь сделки: свои и расшаренные',
  own_and_subordinates: 'Видишь сделки: свои и подчинённых',
  own_and_department: 'Видишь сделки: свои и своего отдела',
  all: 'Видишь сделки: все записи проекта',
};

export function formatVisibilityLevelLabel(level: string): string {
  return VISIBILITY_LEVEL_LABELS_RU[level] ?? level;
}
