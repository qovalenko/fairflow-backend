import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_MODULE_IDS,
  buildProjectCatalogWithSystem,
  decideRbac,
  expandSystemRolePermissions,
  projectRoleCanKey,
  PROJECT_ROLES,
  type PermissionAction,
  type ProjectRole,
} from '@fairflow/shared';

/**
 * TODO-027 — «роль × предмет × действие: до и после».
 *
 * The gateway now enforces TWO layers on every @RequirePermission route: the flat
 * role×action matrix (`projectRoleCanKey`, unchanged) AND control's granular
 * verdict (`decideRbac` over the project's permission catalog). For the five
 * BASE project roles the second layer must agree with the first, or existing
 * projects silently lose access the day this ships.
 *
 * This suite derives the table from the source of truth on both sides:
 *  - the left side is every `@RequirePermission(subject, action)` actually
 *    present in gateway/src (scanned, so a new decorator cannot slip in
 *    unchecked);
 *  - the right side is `decideRbac` fed with exactly what control materializes
 *    for a base role (`expandSystemRolePermissions` over the project catalog) —
 *    the same functions `RolesService.resolveEffective` uses.
 *
 * Every divergence must be listed in DOCUMENTED_DIVERGENCES with a reason.
 */

const GATEWAY_SRC = join(__dirname, '..');

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/** Every literal `@RequirePermission('subject', 'action')` in gateway/src. */
function scanRequiredPermissions(): Array<{ subject: string; action: PermissionAction }> {
  const re = /@RequirePermission\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
  const seen = new Map<string, { subject: string; action: PermissionAction }>();
  for (const file of collectTsFiles(GATEWAY_SRC)) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      seen.set(`${m[1]}:${m[2]}`, { subject: m[1], action: m[2] as PermissionAction });
    }
  }
  return [...seen.values()].sort((a, b) =>
    `${a.subject}:${a.action}`.localeCompare(`${b.subject}:${b.action}`),
  );
}

/**
 * Cells where the granular engine deliberately does NOT reproduce the flat
 * matrix. Anything not listed here is a regression.
 */
const DOCUMENTED_DIVERGENCES: Record<string, string> = {
  // member × reports:export — the FLAT MATRIX is the side that diverges from the
  // canon, and the canon already fixes this cell. `docs/20-requirements/17-reports.md`
  // §2 «Роли и права»:
  //     `reports:export` — экспорт | owner ✅ | admin ✅ | manager ✅ | member ❌¹ | viewer ❌
  // (¹ → OQ-REPORTS-060 «Экспорт Member'ом собственного среза … включать или
  // оставить право только у Manager+» — an OPEN question, i.e. the canonical
  // default is manager+ and RELAXING it for member is what would need an owner
  // decision, not keeping it.)
  //
  // The catalog side has always implemented that cell (§7.4 elevated-pair
  // carve-out, `ELEVATED_EXPORT_SUBJECTS` in shared/src/permission-rbac.ts):
  // the materialized `member` role, the role editor and the FE projection
  // (`PdpService.resolveProjection` → `allowed[]` → `can('reports','export')`,
  // frontend/modules/reports/src/Reports.tsx:460 — the button is already hidden)
  // all deny it. Only the live route let a member through, because the flat
  // matrix has no subject axis and therefore cannot express a per-subject
  // carve-out. Making the catalog authoritative on the hot path is verbatim what
  // TODO-027 «Как чинить» prescribes ("`projectRoleCan` оставить как быстрый
  // предфильтр …, но окончательное решение принимать по каталогу"), so this cell
  // is the code catching up with the canon — not a new product decision taken here.
  //
  // Scope of the carve-out: ANALYTIC export only. Working-data export
  // (deals/contacts/companies/orders/products/activities) stays with member and
  // is pinned below, so a future edit of ELEVATED_EXPORT_SUBJECTS cannot quietly
  // grow into a blanket member-export ban.
  'member|reports:export': 'ELEVATED_ANALYTIC_EXPORT (17-reports.md §2, OQ-REPORTS-060)',
  // Same elevated-analytic carve-out as reports:export — `statistics` is in
  // ELEVATED_EXPORT_SUBJECTS; member/viewer are denied in the catalog (TODO-089/
  // TODO-110) while the flat matrix still allows export for every role.
  'member|statistics:export': 'ELEVATED_ANALYTIC_EXPORT (18-statistics.md FR-MSTAT-10)',
};

describe('TODO-027 — base-role parity of the two enforcement layers', () => {
  const catalog = buildProjectCatalogWithSystem(ALL_MODULE_IDS);
  const effectiveOf = (role: ProjectRole) => ({
    allow: expandSystemRolePermissions(role, catalog) as string[],
    deny: [] as string[],
  });
  const pairs = scanRequiredPermissions();

  it('finds the decorator pairs to compare (guards against a broken scan)', () => {
    expect(pairs.length).toBeGreaterThan(40);
    expect(pairs).toContainEqual({ subject: 'deals', action: 'delete' });
  });

  describe.each(PROJECT_ROLES)('role %s', (role) => {
    it('decides every @RequirePermission pair exactly as the flat matrix', () => {
      const effective = effectiveOf(role);
      const regressions: string[] = [];
      for (const { subject, action } of pairs) {
        const legacy = projectRoleCanKey(role, subject, action);
        const d = decideRbac(subject, action, effective, catalog);
        // No key in the catalog ⇒ the engine abstains and the PEP keeps the flat
        // verdict (see PermissionDecision.not_applicable) ⇒ no behaviour change.
        if (d.reason === 'PERMISSION_MAPPING_MISSING') continue;
        const granular = d.decision === 'allow';
        if (granular === legacy) continue;
        const documented = DOCUMENTED_DIVERGENCES[`${role}|${subject}:${action}`];
        if (documented) continue;
        regressions.push(
          `${role} × ${subject}:${action}: matrix=${legacy ? 'allow' : 'deny'} ` +
            `pdp=${d.decision} (${d.reason})`,
        );
      }
      expect(regressions).toEqual([]);
    });
  });

  it('the granular layer never WIDENS a base role beyond the flat matrix', () => {
    // Composition on the gateway is a strict AND, but assert the data too: a
    // catalog/expansion change must not hand a base role something the matrix
    // denies without someone noticing here.
    const widenings: string[] = [];
    for (const role of PROJECT_ROLES) {
      const effective = effectiveOf(role);
      for (const { subject, action } of pairs) {
        const d = decideRbac(subject, action, effective, catalog);
        if (d.decision === 'allow' && !projectRoleCanKey(role, subject, action)) {
          widenings.push(`${role} × ${subject}:${action}`);
        }
      }
    }
    expect(widenings).toEqual([]);
  });

  /**
   * The single documented divergence, pinned cell by cell against the canon
   * (`docs/20-requirements/17-reports.md` §2) instead of living only as a key in
   * DOCUMENTED_DIVERGENCES. If someone edits ELEVATED_EXPORT_SUBJECTS in either
   * direction, these fail and point at the canon + OQ-REPORTS-060.
   */
  describe('canonical cell: reports:export is manager+ (17-reports.md §2)', () => {
    const verdictOf = (role: ProjectRole) =>
      decideRbac('reports', 'export', effectiveOf(role), catalog).decision;

    it.each([
      ['owner', 'allow'],
      ['admin', 'allow'],
      ['manager', 'allow'],
      ['member', 'deny'],
      ['viewer', 'deny'],
    ] as Array<[ProjectRole, string]>)('%s → %s', (role, expected) => {
      expect(verdictOf(role)).toBe(expected);
    });

    it('leaves working-data export with member (analytic-only carve-out)', () => {
      const subjects = ['deals', 'contacts', 'companies', 'orders', 'products', 'activities'];
      const denied = subjects.filter(
        (subject) =>
          decideRbac(subject, 'export', effectiveOf('member'), catalog).decision !== 'allow',
      );
      expect(denied).toEqual([]);
    });

    it('server verdict and the FE button gate read the SAME set (no invisible 403)', () => {
      // The FE disables the export button from `resolveProjection.allowed[]`,
      // which for a base role IS `expandSystemRolePermissions` — literally the
      // input `decideRbac` gets here. So a member never sees an enabled button
      // that then 403s, and a manager never sees a hidden one that would pass.
      expect(effectiveOf('member').allow).not.toContain('reports:export');
      expect(effectiveOf('manager').allow).toContain('reports:export');
    });
  });

  it('lists the pairs that carry no granular opinion yet (catalog gaps)', () => {
    const gaps = pairs
      .filter(
        ({ subject, action }) =>
          decideRbac(subject, action, effectiveOf('owner'), catalog).reason ===
          'PERMISSION_MAPPING_MISSING',
      )
      .map(({ subject, action }) => `${subject}:${action}`);
    // These decorators have no key in any module manifest, so no role and no
    // PermissionGrant can reference them: the flat matrix alone governs them
    // until the manifests gain the capability (owner call — see TODO-027 notes).
    // Keeping the list pinned makes any NEW gap visible in review instead of
    // silently degrading a route to matrix-only enforcement.
    // statistics:export landed in the catalog (TODO-089/TODO-110) — no gaps left.
    expect(gaps.sort()).toEqual([]);
  });
});
