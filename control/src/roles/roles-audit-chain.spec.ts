import { RolesService } from './roles.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { OrgPdpService } from '../organizations/org-pdp.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { RoleAuditService } from '../outbox/role-audit.service';

// No-op outbox emitter: this spec verifies the T5.1 hash chain only; the bus
// emission is covered separately in control-outbox.spec.ts.
const noopEmitter = { emit: async () => undefined } as unknown as ControlEventEmitter;

/**
 * P8 T5.1: RoleAuditLog hash chain — writer (private `audit(tx, …)`) + verifier
 * (`verifyChain(scope)`). Uses an in-memory Prisma fake that doubles as the
 * transaction client so the real append path runs (advisory-lock no-op → prev →
 * hash → insert). Chain is per project (or per org for org-scoped role entries).
 */
interface Row {
  id: string;
  projectId: string | null;
  orgId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
  chainHash: string | null;
  prevHash: string | null;
  _seq: number;
}

function makeFakePrisma() {
  const rows: Row[] = [];
  let seq = 0;
  const matchScope = (r: Row, where: { projectId?: string; orgId?: string }) =>
    (where.projectId !== undefined ? r.projectId === where.projectId : true) &&
    (where.orgId !== undefined ? r.orgId === where.orgId : true);

  const store = {
    rows,
    roleAuditLog: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async ({ data }: { data: any }) => {
        const row: Row = {
          id: data.id,
          projectId: data.projectId ?? null,
          orgId: data.orgId ?? null,
          actorUserId: data.actorUserId ?? null,
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId ?? null,
          summary: data.summary ?? null,
          before: data.before ?? null,
          after: data.after ?? null,
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
        let list = rows.filter((r) => matchScope(r, where));
        if (where.chainHash?.not === null) list = list.filter((r) => r.chainHash !== null);
        list = [...list].sort((a, b) =>
          orderBy?.createdAt === 'desc' ? b._seq - a._seq : a._seq - b._seq,
        );
        return list[0] ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => {
        let list = rows.filter((r) => matchScope(r, where));
        if (where.chainHash?.not === null) list = list.filter((r) => r.chainHash !== null);
        return [...list].sort((a, b) => a._seq - b._seq);
      },
    },
    $queryRaw: async () => [{ pg_advisory_xact_lock: '' }],
    $executeRaw: async () => 1, // advisory lock via $executeRaw (void return)
  };
  return store;
}

type AuditEntry = {
  projectId?: string;
  orgId?: string;
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  summary?: string;
  before?: unknown;
  after?: unknown;
};

describe('RolesService RoleAuditLog hash chain (P8 T5.1)', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let service: RolesService;
  // exercise the private writer directly (unit-test seam)
  let writeAudit: (entry: AuditEntry) => Promise<void>;

  beforeEach(() => {
    prisma = makeFakePrisma();
    service = new RolesService(
      prisma as unknown as PrismaService,
      {} as ProjectsService,
      {} as OrgPdpService,
      new RoleAuditService(noopEmitter),
    );
    writeAudit = (entry) =>
      (
        service as unknown as {
          audit: (tx: unknown, e: AuditEntry) => Promise<void>;
        }
      ).audit(prisma, entry);
  });

  const roleEntry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
    projectId: 'proj-1',
    actorUserId: 'actor-1',
    action: 'role.created',
    entityType: 'role',
    entityId: 'role-1',
    after: { name: 'HR', permissions: ['contacts:manage'] },
    ...over,
  });

  it('(в) genesis role entry: prevHash=null, valid chainHash, verifies', async () => {
    await writeAudit(roleEntry());
    expect(prisma.rows[0].prevHash).toBeNull();
    expect(prisma.rows[0].chainHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await service.verifyChain({ projectId: 'proj-1' })).toEqual({
      ok: true,
      checked: 1,
      brokenId: null,
    });
  });

  it('(а) a normal project chain links prev→chain and verifies intact', async () => {
    await writeAudit(roleEntry({ action: 'role.created' }));
    await writeAudit(roleEntry({ action: 'assignment.granted', entityType: 'role_assignment' }));
    await writeAudit(roleEntry({ action: 'role.updated' }));
    expect(prisma.rows[1].prevHash).toBe(prisma.rows[0].chainHash);
    expect(prisma.rows[2].prevHash).toBe(prisma.rows[1].chainHash);
    expect((await service.verifyChain({ projectId: 'proj-1' })).ok).toBe(true);
  });

  it('(б) a retro-edit of before/after is detected at that record', async () => {
    await writeAudit(roleEntry({ action: 'role.created' }));
    await writeAudit(roleEntry({ action: 'role.updated' }));
    await writeAudit(roleEntry({ action: 'role.deleted' }));

    prisma.rows[1].after = { name: 'HACKED', permissions: ['deals:delete'] };

    const res = await service.verifyChain({ projectId: 'proj-1' });
    expect(res.ok).toBe(false);
    expect(res.brokenId).toBe(prisma.rows[1].id);
    expect(res.checked).toBe(1);
  });

  it('project and org role chains are independent scopes', async () => {
    await writeAudit(roleEntry({ projectId: 'proj-1' }));
    await writeAudit(roleEntry({ projectId: undefined, orgId: 'org-9' }));
    expect((await service.verifyChain({ projectId: 'proj-1' })).checked).toBe(1);
    expect((await service.verifyChain({ orgId: 'org-9' })).checked).toBe(1);
    // the org entry did NOT chain off the project genesis
    const orgRow = prisma.rows.find((r) => r.orgId === 'org-9')!;
    expect(orgRow.prevHash).toBeNull();
  });
});
