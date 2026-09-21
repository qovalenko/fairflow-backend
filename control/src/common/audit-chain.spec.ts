import {
  buildAuditPayload,
  canonicalJson,
  chainAdvisoryLockKey,
  computeChainHash,
  type AuditChainPayload,
} from './audit-chain';

describe('audit-chain util (P8 T5.1)', () => {
  const base = {
    scopeType: 'org' as const,
    scopeId: 'org-1',
    action: 'employee.added',
    entityType: 'employee',
    entityId: 'user-1',
    before: null,
    after: { role: 'employee' },
    actorUserId: 'actor-1',
    createdAt: new Date('2026-07-03T10:00:00.000Z'),
  };

  it('canonicalJson sorts object keys recursively and is order-stable', () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it('canonicalJson normalizes undefined to null (Prisma reads back null)', () => {
    expect(canonicalJson({ x: undefined })).toBe(canonicalJson({ x: null }));
  });

  it('canonicalJson preserves array order (arrays are semantic)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('genesis: prevHash null produces a deterministic sha256 (64 hex chars)', () => {
    const payload = buildAuditPayload(base);
    const h = computeChainHash(null, payload);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // deterministic
    expect(computeChainHash(null, buildAuditPayload(base))).toBe(h);
  });

  it('chainHash changes when any hashed field changes (tamper sensitivity)', () => {
    const h0 = computeChainHash(null, buildAuditPayload(base));
    const fields: Array<Partial<typeof base>> = [
      { action: 'employee.removed' },
      { entityId: 'user-2' },
      { actorUserId: 'actor-2' },
      { after: { role: 'admin' } },
      { createdAt: new Date('2026-07-03T10:00:01.000Z') },
      { scopeId: 'org-2' },
    ];
    for (const patch of fields) {
      const h = computeChainHash(null, buildAuditPayload({ ...base, ...patch }));
      expect(h).not.toBe(h0);
    }
  });

  it('chainHash depends on prevHash (link binding)', () => {
    const payload = buildAuditPayload(base);
    const genesis = computeChainHash(null, payload);
    const second = computeChainHash(genesis, payload);
    const forged = computeChainHash('deadbeef', payload);
    expect(second).not.toBe(genesis);
    expect(second).not.toBe(forged);
  });

  it('advisory lock key is a stable signed bigint and scope-distinct', () => {
    const k1 = chainAdvisoryLockKey('org', 'org-1');
    const k2 = chainAdvisoryLockKey('org', 'org-1');
    const k3 = chainAdvisoryLockKey('org', 'org-2');
    const k4 = chainAdvisoryLockKey('role:project', 'org-1');
    expect(typeof k1).toBe('bigint');
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).not.toBe(k4); // scopeType participates in the key
    // fits signed int8 range (pg advisory key domain)
    expect(k1 >= -(2n ** 63n) && k1 < 2n ** 63n).toBe(true);
  });

  it('buildAuditPayload coerces missing before/after/entityId/actor to null', () => {
    const payload: AuditChainPayload = buildAuditPayload({
      scopeType: 'org',
      scopeId: 'org-1',
      action: 'x',
      entityType: 'y',
      entityId: undefined,
      before: undefined,
      after: undefined,
      actorUserId: undefined,
      createdAt: new Date('2026-07-03T10:00:00.000Z'),
    });
    expect(payload.entityId).toBeNull();
    expect(payload.before).toBeNull();
    expect(payload.after).toBeNull();
    expect(payload.actorUserId).toBeNull();
  });
});
