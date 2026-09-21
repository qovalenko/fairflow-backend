import {
  MODULE_REGISTRY,
  normalizeModuleConfigs,
  previewEnableCascade,
  resolveDependencies,
  extractEnabledModulesFromConfigs,
} from './module-registry';
import { DOCUMENT_CONTEXT_TO_MODULE } from './document-context';
import { getModuleManifest } from './module-manifests';

/**
 * TODO-098 / FR-DOCS-320, FR-DOCS-330, FR-ORDERS-495.
 *
 * Инварианты графа зависимостей модулей:
 *  - documents НЕ зависит жёстко от orders (связь донора — мягкая, per-context,
 *    через DOCUMENT_CONTEXT_TO_MODULE);
 *  - products самостоятелен (обратного ребра products → orders нет);
 *  - orders жёстко зависит только от deals, а связка с products — МЯГКАЯ
 *    (`softDependencies`/манифестный `softDependsOn`): каталог не включается
 *    принудительно и не гасит продажи каскадом, потому что жёсткое ребро молча
 *    переопределяет тумблер модуля, которым распоряжается владелец проекта.
 * Чистая логика, без БД и gRPC.
 */
describe('module-registry: граф зависимостей (TODO-098)', () => {
  it('включение documents не тянет за собой orders', () => {
    expect(MODULE_REGISTRY.documents.dependencies).not.toContain('orders');
    expect(resolveDependencies(['documents'])).not.toContain('orders');
  });

  it('выключенный orders не гасит documents каскадом', () => {
    const configs = normalizeModuleConfigs(
      ['contacts', 'companies', 'deals', 'documents'],
      [
        { moduleId: 'orders', enabled: false },
        { moduleId: 'documents', enabled: true },
      ],
    );
    const documents = configs.find((c) => c.moduleId === 'documents');
    expect(documents?.enabled).toBe(true);
    expect(extractEnabledModulesFromConfigs(configs)).not.toContain('orders');
  });

  it('выключенный orders не гасит products каскадом', () => {
    expect(MODULE_REGISTRY.products.dependencies).not.toContain('orders');
    const configs = normalizeModuleConfigs(
      ['deals', 'products'],
      [
        { moduleId: 'orders', enabled: false },
        { moduleId: 'products', enabled: true },
      ],
    );
    expect(configs.find((c) => c.moduleId === 'products')?.enabled).toBe(true);
  });

  it('orders жёстко зависит только от deals (FR-ORDERS-495)', () => {
    expect(MODULE_REGISTRY.orders.dependencies).toEqual(['deals']);
    const resolved = resolveDependencies(['orders']);
    expect(resolved).toEqual(expect.arrayContaining(['orders', 'deals']));
  });

  it('связка orders → products мягкая: каталог не включается принудительно', () => {
    expect(MODULE_REGISTRY.orders.softDependencies).toEqual(['products']);
    // Ключевой инвариант: эффективный набор модулей (его читают
    // GatewayModuleGuard/ProjectAccessGuard) не должен открывать маршруты
    // `@RequireModule('products')` в проекте, где каталог выключен владельцем.
    expect(resolveDependencies(['orders'])).not.toContain('products');
    const configs = normalizeModuleConfigs(
      ['deals', 'orders'],
      [
        { moduleId: 'orders', enabled: true },
        { moduleId: 'products', enabled: false },
      ],
    );
    expect(configs.find((c) => c.moduleId === 'products')?.enabled).toBe(false);
    expect(extractEnabledModulesFromConfigs(configs)).not.toContain('products');
  });

  it('выключенный products не гасит orders каскадом', () => {
    const configs = normalizeModuleConfigs(
      ['deals', 'orders'],
      [
        { moduleId: 'products', enabled: false },
        { moduleId: 'orders', enabled: true },
      ],
    );
    expect(configs.find((c) => c.moduleId === 'orders')?.enabled).toBe(true);
  });

  it('мягкое ребро попадает в манифест как softDependsOn, а не как dependsOn', () => {
    const manifest = getModuleManifest('orders');
    expect(manifest?.dependsOn).toEqual(['deals']);
    expect(manifest?.softDependsOn).toEqual(['products']);
  });

  it('в графе нет циклов: resolveDependencies завершается для каждого модуля', () => {
    for (const id of Object.keys(MODULE_REGISTRY)) {
      expect(resolveDependencies([id])).toContain(id);
    }
  });

  it('каждый донор контекста документов — существующий модуль реестра', () => {
    for (const moduleId of Object.values(DOCUMENT_CONTEXT_TO_MODULE)) {
      expect(MODULE_REGISTRY[moduleId]).toBeDefined();
    }
  });

  it('previewEnableCascade lists hard dependencies that resolveDependencies would add (FR-PSET-050)', () => {
    // `contacts` already pulls locked `deals` via resolveDependencies — no extra cascade for orders.
    expect(previewEnableCascade('orders', ['contacts'])).toEqual([]);
    expect(previewEnableCascade('search', ['deals'])).toEqual(
      expect.arrayContaining(['contacts', 'companies']),
    );
    expect(previewEnableCascade('products', ['deals'])).toEqual([]);
  });
});
