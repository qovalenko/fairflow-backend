/**
 * TODO-109: record shares in a CROSS-ENTITY store (the global search index).
 *
 * AS-IS the search domain reused `buildVisibilityFilter`, whose share disjunct is
 * `_id ∈ sharedRecordIds` — but a search-index document's `_id` is the INDEX row
 * id, while a share carries the SOURCE record id. The two never matched, so a
 * record shared with the viewer was findable on its own list route and invisible
 * in global search. `buildCrossEntityVisibilityFilter` matches `(entityType,
 * entityId)` instead, from the per-type map the gateway resolves cross-resource.
 */
import {
  buildCrossEntityVisibilityFilter,
  parseVisibilityScope,
  serializeVisibilityScope,
  SHAREABLE_RESOURCES,
  SHAREABLE_RESOURCE_ENTITY_TYPES,
  CROSS_ENTITY_SUBJECT_ENTITY_TYPES,
  CROSS_ENTITY_TYPE_SUBJECTS,
  type VisibilityScope,
} from './rbac';

const FIELDS = { typeField: 'entityType', idField: 'entityId' };

const restricted = (over: Partial<VisibilityScope> = {}): VisibilityScope => ({
  mode: 'restricted',
  level: 'custom',
  selfId: 'u-1',
  ownerIds: ['u-1'],
  sharedRecordIds: [],
  ...over,
});

describe('buildCrossEntityVisibilityFilter (TODO-109)', () => {
  it('matches shares by (entityType, entityId), never by the index document id', () => {
    const scope = restricted({
      sharedRecordIdsByType: { contact: ['c-9'], deal: ['d-7', 'd-8'] },
    });
    expect(buildCrossEntityVisibilityFilter(scope, 'ownerId', FIELDS)).toEqual({
      $or: [
        { ownerId: { $in: ['u-1'] } },
        { entityType: 'contact', entityId: { $in: ['c-9'] } },
        { entityType: 'deal', entityId: { $in: ['d-7', 'd-8'] } },
      ],
    });
  });

  it('ignores the single-resource sharedRecordIds (they would match a foreign id space)', () => {
    // A cross-resource scope has no single `resource`, so these ids — if a stale
    // gateway ever sent them — belong to an UNKNOWN resource. Applying them to
    // `entityId` would grant a same-id record of a different type.
    const scope = restricted({ sharedRecordIds: ['c-9'] });
    expect(buildCrossEntityVisibilityFilter(scope, 'ownerId', FIELDS)).toEqual({
      ownerId: { $in: ['u-1'] },
    });
  });

  it('drops empty/blank entries and de-duplicates ids', () => {
    const scope = restricted({
      sharedRecordIdsByType: { contact: ['c-1', 'c-1'], company: [], '': ['x'] },
    });
    expect(buildCrossEntityVisibilityFilter(scope, 'ownerId', FIELDS)).toEqual({
      $or: [{ ownerId: { $in: ['u-1'] } }, { entityType: 'contact', entityId: { $in: ['c-1'] } }],
    });
  });

  it('mode "all" → no narrowing at all (null), shares are irrelevant', () => {
    const scope = restricted({ mode: 'all', ownerIds: [], sharedRecordIdsByType: { deal: ['d-1'] } });
    expect(buildCrossEntityVisibilityFilter(scope, 'ownerId', FIELDS)).toBeNull();
  });

  it('fail-closed: no scope → deny-all, and shares are NOT appended to it', () => {
    expect(buildCrossEntityVisibilityFilter(undefined, 'ownerId', FIELDS)).toEqual({ $nor: [{}] });
  });

  it('fail-closed: an unhydrated DEFERRED scope stays deny-all even with a share map', () => {
    const scope = restricted({
      deferred: true,
      descriptor: {
        unitIds: [],
        ledUnitIds: [],
        selectedGroupIds: [],
        ruleKinds: ['own'],
        usesSharing: true,
        orgId: 'org-1',
      },
      ownerIds: [],
      sharedRecordIdsByType: { deal: ['d-1'] },
    });
    expect(buildCrossEntityVisibilityFilter(scope, 'ownerId', FIELDS)).toEqual({ $nor: [{}] });
  });
});

describe('sharedRecordIdsByType survives the x-visibility-scope round-trip', () => {
  it('serialize → parse keeps the per-type map', () => {
    const scope = restricted({ sharedRecordIdsByType: { contact: ['c-1'], order: ['o-2'] } });
    const back = parseVisibilityScope(serializeVisibilityScope(scope));
    expect(back?.sharedRecordIdsByType).toEqual({ contact: ['c-1'], order: ['o-2'] });
  });

  it('tolerant parse: non-string ids/keys and empty lists are dropped, field absent when nothing is left', () => {
    const raw = Buffer.from(
      JSON.stringify({
        mode: 'restricted',
        level: 'custom',
        selfId: 'u-1',
        ownerIds: ['u-1'],
        sharedRecordIds: [],
        sharedRecordIdsByType: { contact: ['c-1', 42, ''], deal: [], company: 'nope' },
      }),
      'utf8',
    ).toString('base64');
    expect(parseVisibilityScope(raw)?.sharedRecordIdsByType).toEqual({ contact: ['c-1'] });

    const empty = Buffer.from(
      JSON.stringify({
        mode: 'restricted',
        level: 'custom',
        selfId: 'u-1',
        ownerIds: [],
        sharedRecordIds: [],
        sharedRecordIdsByType: { deal: [] },
      }),
      'utf8',
    ).toString('base64');
    expect(parseVisibilityScope(empty)).not.toHaveProperty('sharedRecordIdsByType');
  });
});

describe('shareable-resource contract', () => {
  it('every shareable resource has a canonical singular entity type', () => {
    for (const resource of SHAREABLE_RESOURCES) {
      expect(SHAREABLE_RESOURCE_ENTITY_TYPES[resource]).toBeTruthy();
    }
    // The map must not carry keys outside the list (they would key a share bucket
    // no consumer resolves).
    expect(Object.keys(SHAREABLE_RESOURCE_ENTITY_TYPES).sort()).toEqual([...SHAREABLE_RESOURCES].sort());
  });
});

/**
 * review-1: the cross-entity subject↔type map is the SINGLE contract the gateway
 * PEP (predicate disjuncts) and the search index (entityType vocabulary) both
 * derive from. A type indexed but missing from the map would match no disjunct and
 * silently vanish from every ABAC-narrowed search, so the two directions and the
 * overlap with the sharing map are pinned here.
 */
describe('cross-entity subject/type contract (review-1)', () => {
  it('is a bijection between data-subjects and singular entity types', () => {
    const subjects = Object.keys(CROSS_ENTITY_SUBJECT_ENTITY_TYPES);
    const types = Object.values(CROSS_ENTITY_SUBJECT_ENTITY_TYPES);
    expect(new Set(types).size).toBe(types.length);
    expect(Object.keys(CROSS_ENTITY_TYPE_SUBJECTS).sort()).toEqual([...types].sort());
    for (const subject of subjects) {
      expect(CROSS_ENTITY_TYPE_SUBJECTS[CROSS_ENTITY_SUBJECT_ENTITY_TYPES[subject]]).toBe(subject);
    }
  });

  it('covers every shareable resource and agrees with the sharing map', () => {
    for (const resource of SHAREABLE_RESOURCES) {
      expect(CROSS_ENTITY_SUBJECT_ENTITY_TYPES[resource]).toBe(
        SHAREABLE_RESOURCE_ENTITY_TYPES[resource],
      );
    }
    // Superset, not equal: products are indexable but carry no per-record sharing.
    expect(Object.keys(CROSS_ENTITY_SUBJECT_ENTITY_TYPES)).toContain('products');
    expect(Object.keys(SHAREABLE_RESOURCE_ENTITY_TYPES)).not.toContain('products');
  });
});
