import { buildProjectCatalogWithSystem, expandSystemRolePermissions, resolveDecoratorPermission } from './permission-rbac';

/**
 * TODO-089 / TODO-110: право `statistics:export` отсутствовало в каталоге прав,
 * хотя его требуют ОБА конца — PEP gateway
 * (`@RequirePermission('statistics','export')` на GET /api/v1/statistics/export)
 * и кнопка «Экспорт» на аналитике (`can('statistics','export')`). Каталог —
 * единственный источник ключей для expandSystemRolePermissions («Only pairs that
 * exist in the catalog are emitted»), поэтому пара не попадала в allowed[] НИ У
 * КОГО, включая owner: кнопка была disabled у всех ролей, а
 * resolveDecoratorPermission вернул бы null → deny PERMISSION_MAPPING_MISSING,
 * как только PEP переедет на каталожный путь.
 *
 * Здесь зафиксировано: ключ в каталоге есть, декоратор резолвится, и при этом
 * аналитический экспорт остаётся элевированным (member/viewer его не получают —
 * `statistics` в ELEVATED_EXPORT_SUBJECTS).
 */
describe('statistics:export в каталоге прав (TODO-089/TODO-110, FR-MSTAT-10)', () => {
  const catalog = buildProjectCatalogWithSystem(['statistics']);

  it('пара statistics:export есть в каталоге проекта с включённой статистикой', () => {
    expect(catalog.hasKey('statistics:read')).toBe(true);
    expect(catalog.hasKey('statistics:export')).toBe(true);
  });

  it('декоратор @RequirePermission(statistics, export) резолвится в каталожный ключ', () => {
    expect(resolveDecoratorPermission('statistics', 'export', catalog)).toEqual([
      'statistics:export',
    ]);
    // read по-прежнему резолвится (не сломали соседнюю пару).
    expect(resolveDecoratorPermission('statistics', 'read', catalog)).toEqual(['statistics:read']);
  });

  it('ключ получают owner/admin/manager, а member/viewer — нет (экспорт аналитики элевирован)', () => {
    for (const role of ['owner', 'admin', 'manager'] as const) {
      expect(expandSystemRolePermissions(role, catalog)).toContain('statistics:export');
    }
    for (const role of ['member', 'viewer'] as const) {
      expect(expandSystemRolePermissions(role, catalog)).not.toContain('statistics:export');
      // read при этом остаётся у всех ролей — экспорт не забрал чтение.
      expect(expandSystemRolePermissions(role, catalog)).toContain('statistics:read');
    }
  });

  it('каталог не приобрёл лишних действий над statistics (write/delete/manage)', () => {
    expect(catalog.hasKey('statistics:write')).toBe(false);
    expect(catalog.hasKey('statistics:delete')).toBe(false);
    expect(catalog.hasKey('statistics:manage')).toBe(false);
  });
});
