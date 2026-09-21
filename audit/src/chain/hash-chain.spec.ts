import {
  ChainContent,
  ChainRecord,
  GENESIS_HASH,
  canonicalize,
  computeHash,
  linkRecord,
  verifyChain,
} from './hash-chain';

/**
 * Synthetic hash-chain integrity tests (E3-03 gate, RFC-ACCESS-GROUPS R8):
 * prove the chain is tamper-evident without RabbitMQ/Mongo. A built chain
 * verifies OK; any altered / re-ordered / deleted / inserted record breaks it.
 */
describe('hash-chain (synthetic)', () => {
  function content(seq: number, action: string, data?: unknown): ChainContent {
    return {
      chainKey: 'org|org_1|p1',
      seq,
      action,
      actorId: 'u_1',
      actorType: 'user',
      organizationId: 'org_1',
      projectId: 'p1',
      idempotencyKey: `${action}:${seq}`,
      createdAt: 1_700_000_000_000 + seq,
      data,
    };
  }

  function buildChain(actions: string[]): ChainRecord[] {
    const records: ChainRecord[] = [];
    let prev = GENESIS_HASH;
    actions.forEach((action, i) => {
      const rec = linkRecord(prev, content(i + 1, action));
      records.push(rec);
      prev = rec.hash;
    });
    return records;
  }

  it('canonicalize is key-order independent', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('genesis record links to GENESIS_HASH', () => {
    const chain = buildChain(['control.role.changed']);
    expect(chain[0].prevHash).toBe(GENESIS_HASH);
    expect(chain[0].seq).toBe(1);
  });

  it('verifies an intact chain of R8 permission events', () => {
    const chain = buildChain([
      'control.role.changed',
      'control.member.added',
      'control.module.enabled',
      'control.visibility.changed',
    ]);
    expect(verifyChain(chain)).toEqual({ status: 'ok', checked: 4 });
  });

  it('empty chain is ok', () => {
    expect(verifyChain([])).toEqual({ status: 'ok', checked: 0 });
  });

  it('detects content tampering (altered record)', () => {
    const chain = buildChain(['control.role.changed', 'control.member.added', 'control.module.enabled']);
    // Forge the 2nd record's action without recomputing downstream hashes.
    chain[1] = { ...chain[1], action: 'control.role.revoked' };
    const result = verifyChain(chain);
    expect(result.status).toBe('broken');
    expect(result.brokenAt?.seq).toBe(2);
    expect(result.brokenAt?.reason).toBe('hash_mismatch');
  });

  it('detects deletion (broken prevHash link)', () => {
    const chain = buildChain(['control.role.changed', 'control.member.added', 'control.module.enabled']);
    // Remove the middle record → seq gap at the former 3rd record.
    const tampered = [chain[0], chain[2]];
    const result = verifyChain(tampered);
    expect(result.status).toBe('broken');
    expect(result.brokenAt?.reason).toBe('seq_gap');
  });

  it('detects insertion / reorder via prev_hash_mismatch', () => {
    const chain = buildChain(['control.role.changed', 'control.member.added']);
    const forged = linkRecord('deadbeef'.repeat(8), content(2, 'control.role.revoked'));
    const tampered = [chain[0], forged];
    const result = verifyChain(tampered);
    expect(result.status).toBe('broken');
    expect(result.brokenAt?.seq).toBe(2);
    expect(result.brokenAt?.reason).toBe('prev_hash_mismatch');
  });

  it('hash is deterministic for identical content', () => {
    const c = content(1, 'control.role.changed', { before: { x: 1 }, after: { x: 2 } });
    expect(computeHash(GENESIS_HASH, c)).toBe(computeHash(GENESIS_HASH, c));
  });
});
