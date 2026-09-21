/**
 * [#19] Unit tests for the shared visibility-scope hydration primitives, run from
 * the contact workspace (which has ts-jest wired and consumes @fairflow/shared).
 */
import {
  buildVisibilityFilter,
  hydrateVisibilityScope,
  parseVisibilityScope,
  serializeVisibilityScope,
  DENY_ALL_FILTER,
  isRecordVisible,
  type VisibilityScope,
} from '@fairflow/shared';

const deferredScope = (): VisibilityScope => ({
  mode: 'restricted',
  level: 'own_and_department',
  selfId: 'u1',
  ownerIds: [],
  sharedRecordIds: [],
  deferred: true,
  descriptor: {
    unitIds: ['g1'],
    ledUnitIds: [],
    selectedGroupIds: [],
    ruleKinds: ['own_groups'],
    usesSharing: true,
    orgId: 'org1',
  },
  epoch: 7,
  resource: 'contacts',
});

describe('[#19] visibility scope serialize/parse with epoch+resource', () => {
  it('roundtrips epoch and resource stamps', () => {
    const scope = deferredScope();
    const parsed = parseVisibilityScope(serializeVisibilityScope(scope));
    expect(parsed).toBeDefined();
    expect(parsed!.epoch).toBe(7);
    expect(parsed!.resource).toBe('contacts');
    expect(parsed!.deferred).toBe(true);
    expect(parsed!.descriptor?.orgId).toBe('org1');
  });

  it('tolerates absence of epoch/resource (older gateway)', () => {
    const scope: VisibilityScope = {
      mode: 'restricted',
      level: 'only_own',
      selfId: 'u1',
      ownerIds: ['u1'],
      sharedRecordIds: [],
    };
    const parsed = parseVisibilityScope(serializeVisibilityScope(scope));
    expect(parsed).toBeDefined();
    expect(parsed!.epoch).toBeUndefined();
    expect(parsed!.resource).toBeUndefined();
  });
});

describe('[#19] hydrateVisibilityScope', () => {
  it('clears deferred/descriptor and sets the resolved lists, preserving stamps', () => {
    const hydrated = hydrateVisibilityScope(deferredScope(), {
      ownerIds: ['u1', 'u2', 'u3'],
      sharedRecordIds: ['rec1'],
    });
    expect(hydrated.deferred).toBeUndefined();
    expect(hydrated.descriptor).toBeUndefined();
    expect(hydrated.ownerIds).toEqual(['u1', 'u2', 'u3']);
    expect(hydrated.sharedRecordIds).toEqual(['rec1']);
    expect(hydrated.epoch).toBe(7);
    expect(hydrated.resource).toBe('contacts');
  });

  it('is a no-op for a non-deferred scope', () => {
    const scope: VisibilityScope = {
      mode: 'restricted',
      level: 'only_own',
      selfId: 'u1',
      ownerIds: ['u1'],
      sharedRecordIds: [],
    };
    expect(hydrateVisibilityScope(scope, { ownerIds: ['x'], sharedRecordIds: [] })).toBe(scope);
  });

  it('does not mutate the input scope', () => {
    const scope = deferredScope();
    hydrateVisibilityScope(scope, { ownerIds: ['u2'], sharedRecordIds: [] });
    expect(scope.deferred).toBe(true);
    expect(scope.ownerIds).toEqual([]);
  });
});

describe('[#19] fail-closed contract around hydration', () => {
  it('deferred (unhydrated) scope → buildVisibilityFilter deny-all', () => {
    expect(buildVisibilityFilter(deferredScope(), 'ownerId')).toEqual(DENY_ALL_FILTER);
    expect(isRecordVisible(deferredScope(), 'u1')).toBe(false);
  });

  it('after hydration → buildVisibilityFilter is NOT deny-all and applies lists', () => {
    const hydrated = hydrateVisibilityScope(deferredScope(), {
      ownerIds: ['u1', 'u2'],
      sharedRecordIds: [],
    });
    const filter = buildVisibilityFilter(hydrated, 'ownerId');
    expect(filter).not.toEqual(DENY_ALL_FILTER);
    expect(filter).toEqual({ ownerId: { $in: ['u1', 'u2'] } });
    expect(isRecordVisible(hydrated, 'u2')).toBe(true);
    expect(isRecordVisible(hydrated, 'other')).toBe(false);
  });
});
