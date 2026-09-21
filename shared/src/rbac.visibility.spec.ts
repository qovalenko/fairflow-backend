import {
  isProjectRole,
  isOrgRole,
  projectRoleCan,
  projectRoleAtLeast,
  orgRoleCanManage,
  isVisibilityLevel,
  normalizeVisibilityConfig,
  effectiveVisibilityLevel,
  legacyLevelToPolicy,
  isVisibilityRule,
  serializeVisibilityScope,
  parseVisibilityScope,
  hydrateVisibilityScope,
  visibilityScopeExpandedSize,
  buildVisibilityFilter,
  buildOwnableVisibilityFilter,
  isRecordVisible,
  isOwnableRecordVisible,
  DENY_ALL_FILTER,
  type VisibilityScope,
} from './rbac';

/**
 * Unit tests for the shared RBAC + record-visibility primitives (QA-CI T-036.1,
 * QA-STRATEGY §7 invariant "visibility resolves fail-closed"). Pure logic, no IO —
 * these run in the unit pass. The visibility engine is the 2nd of the 4 access
 * layers; every CRM domain ANDs `buildVisibilityFilter` into its reads, so its
 * fail-closed contract (Д-3) is security-load-bearing.
 */
describe('rbac role predicates', () => {
  it('isProjectRole / isOrgRole recognise only the canonical role strings', () => {
    expect(isProjectRole('owner')).toBe(true);
    expect(isProjectRole('viewer')).toBe(true);
    expect(isProjectRole('platform_owner')).toBe(false);
    expect(isProjectRole(123)).toBe(false);
    expect(isOrgRole('platform_admin')).toBe(true);
    expect(isOrgRole('owner')).toBe(false);
  });

  it('projectRoleCan denies unknown/empty roles and honours the action matrix', () => {
    expect(projectRoleCan(null, 'read')).toBe(false);
    expect(projectRoleCan('', 'read')).toBe(false);
    expect(projectRoleCan('not-a-role', 'read')).toBe(false);
    // viewer can read but not delete; owner can do both.
    expect(projectRoleCan('viewer', 'read')).toBe(true);
    expect(projectRoleCan('viewer', 'delete')).toBe(false);
    expect(projectRoleCan('owner', 'delete')).toBe(true);
  });

  it('projectRoleAtLeast ranks roles and rejects non-roles', () => {
    expect(projectRoleAtLeast('owner', 'admin')).toBe(true);
    expect(projectRoleAtLeast('manager', 'manager')).toBe(true);
    expect(projectRoleAtLeast('member', 'manager')).toBe(false);
    expect(projectRoleAtLeast('viewer', 'member')).toBe(false);
    expect(projectRoleAtLeast(undefined, 'viewer')).toBe(false);
    expect(projectRoleAtLeast('platform_owner', 'viewer')).toBe(false);
  });

  it('orgRoleCanManage only for platform owner/admin', () => {
    expect(orgRoleCanManage('platform_owner')).toBe(true);
    expect(orgRoleCanManage('platform_admin')).toBe(true);
    expect(orgRoleCanManage('employee')).toBe(false);
    expect(orgRoleCanManage(null)).toBe(false);
  });
});

describe('visibility level config', () => {
  it('isVisibilityLevel guards the level enum', () => {
    expect(isVisibilityLevel('only_own')).toBe(true);
    expect(isVisibilityLevel('all')).toBe(true);
    expect(isVisibilityLevel('everything')).toBe(false);
    expect(isVisibilityLevel(null)).toBe(false);
  });

  it('normalizeVisibilityConfig drops bad roles/levels', () => {
    expect(
      normalizeVisibilityConfig({
        member: 'only_own',
        owner: 'nonsense',
        bogus: 'all',
      }),
    ).toEqual({ member: 'only_own' });
    expect(normalizeVisibilityConfig(null)).toEqual({});
    expect(normalizeVisibilityConfig('x')).toEqual({});
  });

  it('FR-ACCESS-315: clamps visibility above RBAC floor (member never all)', () => {
    expect(
      normalizeVisibilityConfig({
        member: 'all',
        viewer: 'all',
        manager: 'all',
      }),
    ).toEqual({
      member: 'own_and_department',
      viewer: 'own_and_department',
      manager: 'all',
    });
  });

  it('effectiveVisibilityLevel: override → default → safest only_own', () => {
    // per-project override wins but is clamped to RBAC floor
    expect(effectiveVisibilityLevel('member', { member: 'all' })).toBe('own_and_department');
    // spec default when no override
    expect(effectiveVisibilityLevel('member')).toBe('own_and_shared');
    expect(effectiveVisibilityLevel('manager')).toBe('all');
    // unknown role → safest
    expect(effectiveVisibilityLevel('nope')).toBe('only_own');
    // invalid override value → role default (then floor clamp)
    expect(effectiveVisibilityLevel('member', { member: 'bad' as never })).toBe('own_and_shared');
  });
});

describe('legacyLevelToPolicy / isVisibilityRule', () => {
  it('maps every legacy level to a policy (1:1, RFC §4)', () => {
    expect(legacyLevelToPolicy('only_own')).toEqual({ rules: [{ kind: 'own' }] });
    expect(legacyLevelToPolicy('own_and_shared')).toEqual({ rules: [{ kind: 'own' }] });
    expect(legacyLevelToPolicy('own_and_subordinates')).toEqual({
      rules: [{ kind: 'own' }, { kind: 'own_subgroups', roots: 'led' }],
    });
    expect(legacyLevelToPolicy('own_and_department')).toEqual({
      rules: [{ kind: 'own' }, { kind: 'own_subgroups', roots: 'member' }],
    });
    expect(legacyLevelToPolicy('all')).toEqual({ rules: [{ kind: 'all' }] });
    expect(legacyLevelToPolicy('weird' as never)).toEqual({ rules: [{ kind: 'own' }] });
  });

  it('isVisibilityRule validates rule shapes incl. required params', () => {
    expect(isVisibilityRule({ kind: 'own' })).toBe(true);
    expect(isVisibilityRule({ kind: 'all' })).toBe(true);
    expect(isVisibilityRule({ kind: 'own_subgroups', roots: 'led' })).toBe(true);
    expect(isVisibilityRule({ kind: 'selected_groups', groupIds: ['g1'] })).toBe(true);
    expect(isVisibilityRule({ kind: 'bogus' })).toBe(false);
    expect(isVisibilityRule(null)).toBe(false);
  });
});

describe('visibility scope serialize/parse (x-visibility-scope wire)', () => {
  const scope: VisibilityScope = {
    mode: 'restricted',
    level: 'own_and_shared',
    selfId: 'u1',
    ownerIds: ['u1', 'u2'],
    sharedRecordIds: ['r1'],
  };

  it('round-trips through base64(JSON)', () => {
    const parsed = parseVisibilityScope(serializeVisibilityScope(scope));
    expect(parsed).toMatchObject({
      mode: 'restricted',
      selfId: 'u1',
      ownerIds: ['u1', 'u2'],
      sharedRecordIds: ['r1'],
    });
  });

  it('preserves optional epoch/resource stamps', () => {
    const parsed = parseVisibilityScope(
      serializeVisibilityScope({ ...scope, epoch: 7, resource: 'contacts' }),
    );
    expect(parsed?.epoch).toBe(7);
    expect(parsed?.resource).toBe('contacts');
  });

  it('returns undefined for empty/garbage/invalid-mode input (fail-closed parse)', () => {
    expect(parseVisibilityScope(undefined)).toBeUndefined();
    expect(parseVisibilityScope('')).toBeUndefined();
    expect(parseVisibilityScope('   ')).toBeUndefined();
    expect(parseVisibilityScope('not-base64-json!!!')).toBeUndefined();
    const badMode = Buffer.from(JSON.stringify({ mode: 'nope' })).toString('base64');
    expect(parseVisibilityScope(badMode)).toBeUndefined();
  });

  it('drops a deferred scope that carries no descriptor (fail-closed, not show-own)', () => {
    const deferredNoDesc = Buffer.from(
      JSON.stringify({ mode: 'restricted', deferred: true }),
    ).toString('base64');
    expect(parseVisibilityScope(deferredNoDesc)).toBeUndefined();
  });

  it('parses a deferred scope WITH a descriptor', () => {
    const raw = Buffer.from(
      JSON.stringify({
        mode: 'restricted',
        deferred: true,
        descriptor: { orgId: 'o1', unitIds: ['g1'], ruleKinds: ['own'], usesSharing: true },
      }),
    ).toString('base64');
    const parsed = parseVisibilityScope(raw);
    expect(parsed?.deferred).toBe(true);
    expect(parsed?.descriptor?.orgId).toBe('o1');
    expect(parsed?.descriptor?.unitIds).toEqual(['g1']);
  });
});

describe('hydrateVisibilityScope / visibilityScopeExpandedSize', () => {
  it('clears deferred and injects the resolved lists', () => {
    const deferred: VisibilityScope = {
      mode: 'restricted',
      level: 'custom',
      selfId: 'u1',
      ownerIds: [],
      sharedRecordIds: [],
      deferred: true,
      epoch: 3,
      resource: 'deals',
      descriptor: {
        unitIds: [],
        ledUnitIds: [],
        selectedGroupIds: [],
        ruleKinds: ['own'],
        usesSharing: false,
        orgId: 'o1',
      },
    };
    const hydrated = hydrateVisibilityScope(deferred, {
      ownerIds: ['u1', 'u9'],
      sharedRecordIds: ['r2'],
    });
    expect(hydrated.deferred).toBeUndefined();
    expect(hydrated.descriptor).toBeUndefined();
    expect(hydrated.ownerIds).toEqual(['u1', 'u9']);
    expect(hydrated.sharedRecordIds).toEqual(['r2']);
    // epoch/resource preserved for cache keying
    expect(hydrated.epoch).toBe(3);
    expect(hydrated.resource).toBe('deals');
    // input untouched
    expect(deferred.deferred).toBe(true);
  });

  it('returns a non-deferred scope unchanged', () => {
    const s: VisibilityScope = {
      mode: 'all',
      level: 'all',
      selfId: 'u1',
      ownerIds: [],
      sharedRecordIds: [],
    };
    expect(hydrateVisibilityScope(s, { ownerIds: ['x'], sharedRecordIds: [] })).toBe(s);
  });

  it('visibilityScopeExpandedSize sums both lists', () => {
    expect(visibilityScopeExpandedSize(['a', 'b'], ['c'])).toBe(3);
    expect(visibilityScopeExpandedSize([], [])).toBe(0);
  });
});

describe('buildVisibilityFilter (fail-closed Д-3)', () => {
  it('undefined scope → deny-all (NEVER show-all)', () => {
    expect(buildVisibilityFilter(undefined, 'ownerId')).toEqual(DENY_ALL_FILTER);
  });

  it("mode 'all' → null (no record narrowing)", () => {
    const s: VisibilityScope = {
      mode: 'all',
      level: 'all',
      selfId: 'u1',
      ownerIds: [],
      sharedRecordIds: [],
    };
    expect(buildVisibilityFilter(s, 'ownerId')).toBeNull();
  });

  it('deferred (unhydrated) scope → deny-all', () => {
    const s: VisibilityScope = {
      mode: 'restricted',
      level: 'custom',
      selfId: 'u1',
      ownerIds: [],
      sharedRecordIds: [],
      deferred: true,
    };
    expect(buildVisibilityFilter(s, 'ownerId')).toEqual(DENY_ALL_FILTER);
  });

  it('restricted with only ownerIds → single owner-in clause on the owner field', () => {
    const s: VisibilityScope = {
      mode: 'restricted',
      level: 'own_and_shared',
      selfId: 'u1',
      ownerIds: ['u1', 'u2'],
      sharedRecordIds: [],
    };
    expect(buildVisibilityFilter(s, 'assigneeId')).toEqual({
      assigneeId: { $in: ['u1', 'u2'] },
    });
  });

  it('restricted with shared ids → OR of owner-in and _id-in', () => {
    const s: VisibilityScope = {
      mode: 'restricted',
      level: 'own_and_shared',
      selfId: 'u1',
      ownerIds: ['u1'],
      sharedRecordIds: [],
    };
    expect(buildVisibilityFilter(s, 'ownerId', ['rec1', 'rec2'])).toEqual({
      $or: [{ ownerId: { $in: ['u1'] } }, { _id: { $in: ['rec1', 'rec2'] } }],
    });
  });

  it('restricted with departmentIds → OR includes department-owned records (FR-COMPANIES-355)', () => {
    const s: VisibilityScope = {
      mode: 'restricted',
      level: 'own_and_department',
      selfId: 'u1',
      ownerIds: ['u1'],
      sharedRecordIds: [],
      departmentIds: ['dep-a', 'dep-b'],
    };
    expect(buildVisibilityFilter(s, 'ownerId', [], 'departmentId')).toEqual({
      $or: [
        { ownerId: { $in: ['u1'] } },
        { departmentId: { $in: ['dep-a', 'dep-b'] } },
      ],
    });
  });
});

describe('isRecordVisible (fail-closed Д-3)', () => {
  const restricted: VisibilityScope = {
    mode: 'restricted',
    level: 'own_and_shared',
    selfId: 'u1',
    ownerIds: ['u1', 'u2'],
    sharedRecordIds: [],
  };

  it('undefined scope → deny (was a fail-open hole)', () => {
    expect(isRecordVisible(undefined, 'u1')).toBe(false);
  });

  it("mode 'all' → always visible", () => {
    const all: VisibilityScope = { ...restricted, mode: 'all', ownerIds: [] };
    expect(isRecordVisible(all, 'anyone')).toBe(true);
  });

  it('unhydrated deferred scope → deny', () => {
    expect(isRecordVisible({ ...restricted, deferred: true }, 'u1')).toBe(false);
  });

  it('restricted: visible when owner is in the list, otherwise denied', () => {
    expect(isRecordVisible(restricted, 'u2')).toBe(true);
    expect(isRecordVisible(restricted, 'u3')).toBe(false);
    expect(isRecordVisible(restricted, null)).toBe(false);
  });

  it('restricted: an explicitly shared record is visible regardless of owner', () => {
    expect(isRecordVisible(restricted, 'stranger', true)).toBe(true);
  });

  it('restricted: department-owned record visible via departmentIds (FR-COMPANIES-355)', () => {
    const deptScope: VisibilityScope = {
      ...restricted,
      ownerIds: ['u1'],
      departmentIds: ['dep-1'],
    };
    expect(isRecordVisible(deptScope, undefined, false, 'dep-1')).toBe(true);
    expect(isRecordVisible(deptScope, undefined, false, 'dep-2')).toBe(false);
  });

  it('only_own without departmentIds does not reveal a colleague company in the same dept', () => {
    const onlyOwn: VisibilityScope = {
      mode: 'restricted',
      level: 'only_own',
      selfId: 'u1',
      ownerIds: ['u1'],
      sharedRecordIds: [],
    };
    expect(isRecordVisible(onlyOwn, 'u2', false, 'dep-1')).toBe(false);
    expect(isRecordVisible(onlyOwn, undefined, false, 'dep-1')).toBe(false);
    expect(buildVisibilityFilter(onlyOwn, 'ownerId', [], 'departmentId')).toEqual({
      ownerId: { $in: ['u1'] },
    });
  });
});

describe('ownable XOR visibility (FR-CONTACTS-285)', () => {
  const restricted: VisibilityScope = {
    mode: 'restricted',
    level: 'own_and_shared',
    selfId: 'u1',
    ownerIds: ['u1'],
    sharedRecordIds: [],
    viewerDepartmentIds: ['dept-a'],
  };

  it('buildOwnableVisibilityFilter adds department disjunct when owner is unset', () => {
    const filter = buildOwnableVisibilityFilter(restricted, 'ownerId', 'departmentId');
    expect(filter).toEqual({
      $or: [
        { ownerId: { $in: ['u1'] } },
        {
          $and: [
            { departmentId: { $in: ['dept-a'] } },
            {
              $or: [{ ownerId: null }, { ownerId: '' }, { ownerId: { $exists: false } }],
            },
          ],
        },
      ],
    });
  });

  it('isOwnableRecordVisible: department-owned record visible to department member', () => {
    expect(isOwnableRecordVisible(restricted, '', 'dept-a')).toBe(true);
    expect(isOwnableRecordVisible(restricted, null, 'dept-a')).toBe(true);
    expect(isOwnableRecordVisible(restricted, '', 'dept-b')).toBe(false);
  });

  it('isOwnableRecordVisible: user owner wins over department (XOR)', () => {
    expect(isOwnableRecordVisible(restricted, 'u1', 'dept-a')).toBe(true);
    expect(isOwnableRecordVisible(restricted, 'stranger', 'dept-a')).toBe(false);
  });

  it('parseVisibilityScope round-trips viewerDepartmentIds', () => {
    const parsed = parseVisibilityScope(serializeVisibilityScope(restricted));
    expect(parsed?.viewerDepartmentIds).toEqual(['dept-a']);
  });
});
