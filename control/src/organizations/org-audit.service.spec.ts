import { OrgAuditService, type OrgAuditEvent } from './org-audit.service';
import { OrgStructureService } from './org-structure.service';
import { PrismaService } from '../prisma/prisma.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';

// No-op outbox emitter: this spec verifies the T5.1 org hash chain only; bus
// emission is covered in control-outbox.spec.ts.
const noopEmitter = { emit: async () => undefined } as unknown as ControlEventEmitter;

/**
 * In-memory fake of the subset of Prisma used by OrgAuditService's chain writer
 * and verifier: `$queryRaw` (advisory lock — no-op), `orgAuditLog.findFirst`
 * (newest chained row of a chain), `orgAuditLog.create`, `orgAuditLog.findMany`
 * (oldest-first for verifyChain). It also plays the transaction client, so
 * record(event, tx) runs the real append path (lock → prev → hash → insert).
 */
interface Row {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date;
  chainHash: string | null;
  prevHash: string | null;
  _seq: number;
}

function makeFakePrisma() {
  const rows: Row[] = [];
  let seq = 0;

  const store = {
    rows,
    orgAuditLog: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async ({ data }: { data: any }) => {
        const row: Row = {
          id: data.id,
          organizationId: data.organizationId,
          actorUserId: data.actorUserId ?? null,
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId ?? null,
          metadata: data.metadata ?? null,
          // Stored createdAt MUST equal the value the writer hashed — do not shift
          // it, or the recompute would diverge. Ordering uses the _seq tiebreaker.
          createdAt: data.createdAt,
          chainHash: data.chainHash ?? null,
          prevHash: data.prevHash ?? null,
          _seq: seq++,
        };
        rows.push(row);
        return row;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async ({ where, orderBy }: any) => {
        let list = rows.filter((r) => r.organizationId === where.organizationId);
        if (where.chainHash?.not === null) list = list.filter((r) => r.chainHash !== null);
        list = [...list].sort((a, b) =>
          orderBy?.createdAt === 'desc' ? b._seq - a._seq : a._seq - b._seq,
        );
        return list[0] ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => {
        let list = rows.filter((r) => r.organizationId === where.organizationId);
        if (where.chainHash?.not === null) list = list.filter((r) => r.chainHash !== null);
        return [...list].sort((a, b) => a._seq - b._seq);
      },
    },
    $queryRaw: async () => [{ pg_advisory_xact_lock: '' }],
    $executeRaw: async () => 1, // advisory lock via $executeRaw (void return)
    // record(event) without tx wraps in $transaction; pass the fake as the tx.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(store),
  };
  return store;
}

const noopPdp = { can: async () => true } as unknown as import('./org-pdp.service').OrgPdpService;

describe('OrgAuditService hash chain (P8 T5.1)', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let service: OrgAuditService;

  const evt = (over: Partial<OrgAuditEvent> = {}): OrgAuditEvent => ({
    organizationId: 'org-1',
    actorUserId: 'actor-1',
    action: 'employee.added',
    entityType: 'employee',
    entityId: 'user-1',
    metadata: { role: 'employee' },
    ...over,
  });

  beforeEach(() => {
    prisma = makeFakePrisma();
    service = new OrgAuditService(prisma as unknown as PrismaService, noopEmitter, noopPdp, {
      resolveLedDepartmentSubtree: jest.fn(),
    } as unknown as OrgStructureService);
  });

  it('(в) genesis: first record has prevHash=null and a valid chainHash', async () => {
    await service.record(evt(), prisma as never);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].prevHash).toBeNull();
    expect(prisma.rows[0].chainHash).toMatch(/^[0-9a-f]{64}$/);
    const res = await service.verifyChain('org-1');
    expect(res).toEqual({ ok: true, checked: 1, brokenId: null });
  });

  it('(а) a normal multi-record chain verifies as intact and links prev→chain', async () => {
    await service.record(evt({ action: 'employee.added' }), prisma as never);
    await service.record(evt({ action: 'employee.updated' }), prisma as never);
    await service.record(evt({ action: 'employee.removed' }), prisma as never);
    // each record's prevHash equals the previous record's chainHash
    expect(prisma.rows[1].prevHash).toBe(prisma.rows[0].chainHash);
    expect(prisma.rows[2].prevHash).toBe(prisma.rows[1].chainHash);
    const res = await service.verifyChain('org-1');
    expect(res).toEqual({ ok: true, checked: 3, brokenId: null });
  });

  it('(б) a retro-edit of a stored field is detected at that record', async () => {
    await service.record(evt({ action: 'employee.added' }), prisma as never);
    await service.record(evt({ action: 'employee.updated' }), prisma as never);
    await service.record(evt({ action: 'employee.removed' }), prisma as never);
    expect((await service.verifyChain('org-1')).ok).toBe(true);

    // Tamper: an attacker rewrites the metadata of the middle record in place
    // (but cannot recompute the whole downstream chain).
    prisma.rows[1].metadata = { role: 'admin' };

    const res = await service.verifyChain('org-1');
    expect(res.ok).toBe(false);
    expect(res.brokenId).toBe(prisma.rows[1].id);
    // the untampered genesis before it still verified
    expect(res.checked).toBe(1);
  });

  it('(б) a retro-edit of the genesis record is detected at record 0', async () => {
    await service.record(evt(), prisma as never);
    await service.record(evt({ action: 'employee.updated' }), prisma as never);
    prisma.rows[0].actorUserId = 'attacker';
    const res = await service.verifyChain('org-1');
    expect(res.ok).toBe(false);
    expect(res.brokenId).toBe(prisma.rows[0].id);
    expect(res.checked).toBe(0);
  });

  it('chains are independent per organization (scope isolation)', async () => {
    await service.record(evt({ organizationId: 'org-1' }), prisma as never);
    await service.record(evt({ organizationId: 'org-2' }), prisma as never);
    const org1 = prisma.rows.filter((r) => r.organizationId === 'org-1');
    const org2 = prisma.rows.filter((r) => r.organizationId === 'org-2');
    expect(org1[0].prevHash).toBeNull();
    expect(org2[0].prevHash).toBeNull(); // org-2 has its own genesis
    expect((await service.verifyChain('org-1')).ok).toBe(true);
    expect((await service.verifyChain('org-2')).ok).toBe(true);
  });
});
