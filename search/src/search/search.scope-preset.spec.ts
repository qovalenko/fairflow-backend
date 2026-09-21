/**
 * TODO-262 / FR-SEARCH-140: the UI scope preset «Мои / Мой отдел / Все доступные».
 *
 * AS-IS the preset existed only in the FE SWR key: switching it re-fetched and
 * returned the identical result set («контрол есть, эффекта нет»). It now travels
 * `?scope=` → gateway → `SearchRequest.owner_scope` → an EXTRA predicate ANDed on
 * top of the visibility filter.
 *
 * What these tests pin is the safety property, not just the plumbing: the preset
 * may only ever REMOVE rows from what the resolved visibility scope already
 * allowed (never widen), and an unresolvable preset fails closed (empty), because
 * a preset that silently degrades to "no filter" would show MORE than the user
 * asked for.
 */
import type { VisibilityScope } from '@fairflow/shared';
import { SearchService, normalizeOwnerScope } from './search.service';
import { buildMongo, row } from './fake-mongo.testkit';

const PID = 'proj-1';

/** A wide scope (mode:'all') so the tests isolate the preset from visibility. */
const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

const doc = (
  entityId: string,
  title: string,
  ownerId: string | null,
  departmentId: string | null,
) =>
  row(`contact:${entityId}`, {
    projectId: PID,
    entityType: 'contact',
    entityId,
    title,
    subtitle: '',
    path: `/p/${PID}/contacts/${entityId}`,
    tokens: title.toLowerCase(),
    ownerId,
    departmentId,
    ownerField: 'ownerId',
    abacAttrs: {},
    sourceUpdatedAt: 1,
    deletedAt: null,
    version: 1,
    updatedAt: 1,
  });

function svc() {
  const { mongo } = buildMongo({
    index: [
      doc('c1', 'Иванов свой', 'user-1', 'dep-1'),
      doc('c2', 'Петров отдел', 'user-2', 'dep-1'),
      doc('c3', 'Сидоров чужой', 'user-3', 'dep-2'),
    ],
  });
  return new SearchService(mongo as never);
}

const ids = (r: { list: Array<{ entity_id: string }> }) => r.list.map((h) => h.entity_id).sort();

describe('scope preset (TODO-262)', () => {
  it('normalizeOwnerScope accepts only the three contract values', () => {
    expect(normalizeOwnerScope('my')).toBe('my');
    expect(normalizeOwnerScope(' DEPT ')).toBe('dept');
    expect(normalizeOwnerScope('all')).toBe('all');
    // Garbage must not become a filter (and must not throw) — it degrades to
    // "no narrowing", i.e. exactly the pre-TODO-262 behaviour.
    expect(normalizeOwnerScope('own')).toBeUndefined();
    expect(normalizeOwnerScope(undefined)).toBeUndefined();
    expect(normalizeOwnerScope(42)).toBeUndefined();
  });

  it('absent preset = today’s behaviour: everything the scope allows', async () => {
    const r = await svc().search(PID, 'ов', 0, 25, { ctx: { scope: ALL_SCOPE } });
    expect(ids(r)).toEqual(['c1', 'c2', 'c3']);
    expect(r.total_by_type.contact).toBe(3);
  });

  it('`all` is explicitly a no-op, not a filter', async () => {
    const r = await svc().search(PID, 'ов', 0, 25, {
      ownerScope: 'all',
      ctx: { scope: ALL_SCOPE },
    });
    expect(ids(r)).toEqual(['c1', 'c2', 'c3']);
  });

  it('`my` narrows to the viewer’s own records — and the counts follow', async () => {
    const r = await svc().search(PID, 'ов', 0, 25, {
      ownerScope: 'my',
      ctx: { scope: ALL_SCOPE },
    });
    expect(ids(r)).toEqual(['c1']);
    // The aggregations derive from the same base filter — a preset that changed
    // the list but not `total_by_type` would render «Показать все 3» over 1 hit.
    expect(r.total_by_type.contact).toBe(1);
    expect(r.total).toBe(1);
  });

  it('`my` falls back to x-user-id when the scope carries no selfId', async () => {
    const r = await svc().search(PID, 'ов', 0, 25, {
      ownerScope: 'my',
      ctx: { scope: { ...ALL_SCOPE, selfId: '' }, selfId: 'user-2' },
    });
    expect(ids(r)).toEqual(['c2']);
  });

  it('`my` with no resolvable viewer fails closed (empty), never "no filter"', async () => {
    const r = await svc().search(PID, 'ов', 0, 25, {
      ownerScope: 'my',
      ctx: { scope: { ...ALL_SCOPE, selfId: '' } },
    });
    expect(r.list).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('`dept` narrows to the departments the gateway resolved', async () => {
    const r = await svc().search(PID, 'ов', 0, 25, {
      ownerScope: 'dept',
      scopeDepartmentIds: ['dep-1'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(ids(r)).toEqual(['c1', 'c2']);
    expect(r.total_by_type.contact).toBe(2);
  });

  it('`dept` without departments fails closed (empty), never "no filter"', async () => {
    const r = await svc().search(PID, 'ов', 0, 25, {
      ownerScope: 'dept',
      scopeDepartmentIds: [],
      ctx: { scope: ALL_SCOPE },
    });
    expect(r.list).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('the preset can only narrow: it never re-adds a record the visibility scope hides', async () => {
    // Restricted viewer: sees ONLY user-2's records. Asking for «Мои» (user-1)
    // must not resurrect c1 — the intersection is empty.
    const restricted: VisibilityScope = {
      mode: 'restricted',
      level: 'only_own',
      selfId: 'user-2',
      ownerIds: ['user-2'],
      sharedRecordIds: [],
    };
    const wide = await svc().search(PID, 'ов', 0, 25, { ctx: { scope: restricted } });
    expect(ids(wide)).toEqual(['c2']);

    // A `dept` preset spanning both departments still cannot widen past c2.
    const withPreset = await svc().search(PID, 'ов', 0, 25, {
      ownerScope: 'dept',
      scopeDepartmentIds: ['dep-1', 'dep-2'],
      ctx: { scope: restricted },
    });
    expect(ids(withPreset)).toEqual(['c2']);
  });

  it('an undefined scope stays deny-all even with a preset (fail-closed Д-3)', async () => {
    const r = await svc().search(PID, 'ов', 0, 25, { ownerScope: 'all', ctx: {} });
    expect(r.list).toEqual([]);
    expect(r.total).toBe(0);
  });
});
