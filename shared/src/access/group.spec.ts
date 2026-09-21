import {
  ACCESS_GROUP_KINDS,
  isAccessGroupKind,
  isAccessGroupScopeType,
  isAccessGroupMemberType,
  MAX_GROUP_DEPTH,
} from './group';

/**
 * Unit tests for the Access Unit / Group type guards (E2-06, RFC-ACCESS-GROUPS
 * §2). Pure predicates — they gate untrusted `kind`/`scopeType`/`memberType`
 * values coming off the wire.
 */
describe('access-group type guards', () => {
  it('isAccessGroupKind matches only the four kinds', () => {
    for (const k of ACCESS_GROUP_KINDS) expect(isAccessGroupKind(k)).toBe(true);
    expect(isAccessGroupKind('DEPARTMENT')).toBe(false); // case-sensitive
    expect(isAccessGroupKind('squad')).toBe(false);
    expect(isAccessGroupKind(42)).toBe(false);
    expect(isAccessGroupKind(null)).toBe(false);
  });

  it('isAccessGroupScopeType matches ORGANIZATION | PROJECT only', () => {
    expect(isAccessGroupScopeType('ORGANIZATION')).toBe(true);
    expect(isAccessGroupScopeType('PROJECT')).toBe(true);
    expect(isAccessGroupScopeType('project')).toBe(false);
    expect(isAccessGroupScopeType(undefined)).toBe(false);
  });

  it('isAccessGroupMemberType matches user | group only', () => {
    expect(isAccessGroupMemberType('user')).toBe(true);
    expect(isAccessGroupMemberType('group')).toBe(true);
    expect(isAccessGroupMemberType('org')).toBe(false);
  });

  it('MAX_GROUP_DEPTH is a sane positive cap', () => {
    expect(MAX_GROUP_DEPTH).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_GROUP_DEPTH)).toBe(true);
  });
});
