/**
 * [be-gw-companies] TODO-366 / FR-COMPANIES-300 / FR-COMPANIES-400.
 *
 * Ключ `companies.owner:write` использовали обе стороны — FE гейтит им кнопку
 * «Сменить владельца» (CompanyDetails.tsx: `can('companies.owner','write') ||
 * can('companies','manage')`), а DECORATOR_SUBJECT_MAP отображал на него
 * `companies:reassign` — но в каталоге модуля субъекта `companies.owner` не
 * было. Следствия: проекция allowed[] (control PDP строится из каталога) не
 * отдавала ключ НИКОМУ, включая владельца проекта, → кнопка была скрыта у всех,
 * хотя маршрут `PATCH /companies/:id/owner` работал по `companies:write`;
 * а мапа `companies:reassign` была мёртвой (resolveDecoratorPermission → null,
 * ключа нет в каталоге).
 *
 * Тест держит инвариант «один ключ — одно действие с обеих сторон»: субъект
 * есть в каталоге, а множество системных ролей, которым раскрутка выдаёт
 * `companies.owner:write`, совпадает с множеством ролей, проходящих фактический
 * серверный гейт маршрута (`companies:write`). Иначе гейт FE и гейт API снова
 * разъедутся.
 */
import { buildProjectPermissionCatalog } from './module-registry';
import { expandSystemRolePermissions, resolveDecoratorPermission } from './permission-rbac';
import { PROJECT_ROLES, projectRoleCanKey, type ProjectRole } from './rbac';

const catalog = buildProjectPermissionCatalog(['companies']);

describe('[be-gw-companies] TODO-366: companies.owner:write есть в каталоге прав', () => {
  it('субъект companies.owner объявлен модулем «Компании»', () => {
    expect(catalog.hasKey('companies.owner:write')).toBe(true);
  });

  it('мапа companies:reassign больше не мёртвая', () => {
    expect(resolveDecoratorPermission('companies', 'reassign', catalog)).toEqual([
      'companies.owner:write',
    ]);
  });

  it('ключ выдаётся ровно тем ролям, что проходят серверный гейт companies:write', () => {
    const withKey = PROJECT_ROLES.filter((role) =>
      expandSystemRolePermissions(role as ProjectRole, catalog).includes('companies.owner:write'),
    );
    const passServerGate = PROJECT_ROLES.filter((role) =>
      projectRoleCanKey(role, 'companies', 'write'),
    );
    expect(withKey).toEqual(passServerGate);
    // sanity: владелец проекта видит кнопку, viewer — нет.
    expect(withKey).toContain('owner');
    expect(withKey).not.toContain('viewer');
  });

  it('новый субъект не расширяет права: только write, никаких delete/manage', () => {
    expect(catalog.hasKey('companies.owner:manage')).toBe(false);
    expect(catalog.hasKey('companies.owner:delete')).toBe(false);
    expect(catalog.hasKey('companies.owner:read')).toBe(false);
  });
});
