import { PdpService } from './pdp.service';
import { RolesService } from './roles.service';
import { ProjectsService } from '../projects/projects.service';
import { VisibilityResolverService } from '../organizations/visibility-resolver.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';
import { PrismaService } from '../prisma/prisma.service';
import type { EffectivePermissionSet, PermissionCatalog } from '@fairflow/shared';

/**
 * BX-MODEL-8 §7.4 — safety-by-construction acceptance: the PDP simulator
 * (`simulateExplain`) must never diverge from the enforcement projection
 * (`resolveProjection`). Both consume the SAME shared helpers (`decideRbac`,
 * `evalGate`, `VisibilityResolverService`), so this suite pins the invariant:
 *
 *   simulateExplain(subject:action).decision === 'allow'
 *     ⟺ "subject:action" ∈ resolveProjection().allowed
 *
 * for every non-record-narrowing cell (resource empty / visibility mode=all),
 * plus the fail-closed negatives (§7.4): non-member, missing mapping, unknown
 * ABAC context-ref, uncompilable ABAC condition — all resolve to `deny`.
 *
 * Pure unit test: prisma / roles / visibility / projects / accessEpoch are
 * in-memory doubles; the REAL `simulateExplain` / `resolveProjection` code runs.
 */

interface UserFixture {
  /** effective allow set (already deny-subtracted, as resolveEffective returns). */
  allow: string[];
  role: string;
  /** membership role backing isProjectOwner (owner ⟹ short-circuit). */
  member: 'owner' | 'member' | null;
}

interface ModulePolicyRule {
  id?: string;
  moduleId?: string;
  effect?: string;
  subject?: string;
  action?: string;
  resource?: string;
  condition?: Record<string, unknown>;
}

function makeCatalog(keys: string[]): PermissionCatalog {
  const set = new Set(keys);
  return {
    entries: [],
    keys: [...keys] as PermissionCatalog['keys'],
    has: (subject: string, action: string) => set.has(`${subject}:${action}`),
    hasKey: (key: string) => set.has(key),
  };
}

function buildPdp(opts: {
  users: Record<string, UserFixture>;
  catalogKeys: string[];
  visMode?: 'all' | 'restricted';
  modulePolicies?: ModulePolicyRule[];
}): PdpService {
  const catalog = makeCatalog(opts.catalogKeys);
  const visMode = opts.visMode ?? 'all';

  const roles = {
    resolveEffective: async (_projectId: string, userId: string) => {
      const u = opts.users[userId];
      const allow = u?.allow ?? [];
      const effective: EffectivePermissionSet = { allow: [...allow], deny: [] };
      return { allow: [...allow], deny: [], role: u?.role ?? '', effective };
    },
    getCatalog: async () => catalog,
  } as unknown as RolesService;

  const projects = {
    findOne: async () => ({ modulePolicies: opts.modulePolicies ?? [] }),
  } as unknown as ProjectsService;

  const visibility = {
    resolve: async () => ({
      allowed: true,
      role: '',
      level: 'all',
      mode: visMode,
      ownerIds: [],
      sharedRecordIds: [],
      deferred: false,
    }),
  } as unknown as VisibilityResolverService;

  const accessEpoch = {
    get: async () => 7,
  } as unknown as ProjectAccessEpochService;

  const prisma = {
    projectMember: {
      findUnique: async ({ where }: { where: { projectId_userId: { userId: string } } }) => {
        const u = opts.users[where.projectId_userId.userId];
        return u?.member ? { role: u.member } : null;
      },
    },
    project: {
      findUnique: async () => ({ ownerType: 'INDIVIDUAL', ownerId: '' }),
    },
    employee: {
      findMany: async () => [],
    },
  } as unknown as PrismaService;

  return new PdpService(roles, projects, visibility, accessEpoch, prisma);
}

const PROJECT = 'proj-1';

describe('PDP simulate == enforce (BX-MODEL-8 §7.4)', () => {
  // ── A1: simulate == enforce matrix (≥3 roles, no record narrowing) ──────────
  describe('A1 matrix: simulateExplain allow ⟺ key ∈ resolveProjection.allowed', () => {
    const catalogKeys = ['contacts:read', 'contacts:write', 'deals:read', 'deals:write'];
    const users: Record<string, UserFixture> = {
      // owner — full catalog (short-circuit).
      'owner-u': { allow: [], role: '', member: 'owner' },
      // partial role — read-only on both subjects.
      'partial-u': { allow: ['contacts:read', 'deals:read'], role: 'member', member: 'member' },
      // no rights — plain member, empty effective allow.
      'none-u': { allow: [], role: 'member', member: 'member' },
    };

    it.each(['owner-u', 'partial-u', 'none-u'])(
      'verdicts agree across the full catalog for %s',
      async (userId) => {
        const pdp = buildPdp({ users, catalogKeys, visMode: 'all' });
        const projection = await pdp.resolveProjection(PROJECT, userId);
        const allowedSet = new Set(projection.allowed);

        for (const key of catalogKeys) {
          const [subject, action] = key.split(':');
          const sim = await pdp.simulateExplain({
            projectId: PROJECT,
            userId,
            subject,
            action,
          });
          // The core invariant: the simulator's allow verdict is IDENTICAL to
          // enforcement's `allowed[]` membership for this key.
          expect(sim.decision === 'allow').toBe(allowedSet.has(key));
        }
      },
    );

    it('partial role: exactly the read keys are allowed by both paths', async () => {
      const pdp = buildPdp({ users, catalogKeys, visMode: 'all' });
      const projection = await pdp.resolveProjection(PROJECT, 'partial-u');
      expect([...projection.allowed].sort()).toEqual(['contacts:read', 'deals:read']);

      const readSim = await pdp.simulateExplain({
        projectId: PROJECT,
        userId: 'partial-u',
        subject: 'contacts',
        action: 'read',
      });
      const writeSim = await pdp.simulateExplain({
        projectId: PROJECT,
        userId: 'partial-u',
        subject: 'contacts',
        action: 'write',
      });
      expect(readSim.decision).toBe('allow');
      expect(writeSim.decision).toBe('deny');
    });
  });

  // ── A2: owner short-circuit — full catalog on BOTH paths ─────────────────────
  describe('A2 owner short-circuit', () => {
    const catalogKeys = ['contacts:read', 'contacts:write', 'deals:read', 'deals:write'];
    // Owner carries NO role assignment (fresh project, D10): effective empty,
    // role='' — ownership is derived from ProjectMember only.
    const users: Record<string, UserFixture> = {
      'owner-u': { allow: [], role: '', member: 'owner' },
    };

    it('resolveProjection.allowed is the FULL catalog for the owner', async () => {
      const pdp = buildPdp({ users, catalogKeys });
      const projection = await pdp.resolveProjection(PROJECT, 'owner-u');
      expect([...projection.allowed].sort()).toEqual([...catalogKeys].sort());
    });

    it('simulateExplain allows every catalog cell for the owner (independent of assignment)', async () => {
      const pdp = buildPdp({ users, catalogKeys });
      for (const key of catalogKeys) {
        const [subject, action] = key.split(':');
        const sim = await pdp.simulateExplain({
          projectId: PROJECT,
          userId: 'owner-u',
          subject,
          action,
        });
        expect(sim.decision).toBe('allow');
        expect(sim.role).toBe('owner');
      }
    });
  });

  // ── A3: fail-closed negatives — every path resolves to deny ──────────────────
  describe('A3 fail-closed negatives → decision === deny', () => {
    const catalogKeys = ['deals:read', 'deals:write'];

    it('non-member / no rights: empty effective allow, not owner → RBAC deny', async () => {
      const pdp = buildPdp({
        users: { 'ghost-u': { allow: [], role: '', member: null } },
        catalogKeys,
      });
      const sim = await pdp.simulateExplain({
        projectId: PROJECT,
        userId: 'ghost-u',
        subject: 'deals',
        action: 'read',
      });
      expect(sim.decision).toBe('deny');
      expect(sim.reason.startsWith('RBAC_')).toBe(true);
    });

    it('missing mapping: subject:action absent from catalog → deny even if in allow', async () => {
      const pdp = buildPdp({
        // 'ghost:read' is in the user allow but NOT in the catalog → mapping missing.
        users: { u: { allow: ['ghost:read'], role: 'member', member: 'member' } },
        catalogKeys,
      });
      const sim = await pdp.simulateExplain({
        projectId: PROJECT,
        userId: 'u',
        subject: 'ghost',
        action: 'read',
      });
      expect(sim.decision).toBe('deny');
      expect(sim.reason).toContain('MAPPING_MISSING');
    });

    it('unknown ABAC context-ref: deny-rule with unresolvable ref → fail-closed deny', async () => {
      const pdp = buildPdp({
        // RBAC passes (deals:write allowed), then the ABAC deny rule references a
        // non-existent user attribute → resolveContextRefs throws → deny.
        users: { u: { allow: ['deals:write'], role: 'member', member: 'member' } },
        catalogKeys,
        modulePolicies: [
          {
            id: 'r-unknown-ref',
            moduleId: 'deals',
            effect: 'deny',
            subject: 'deals',
            action: 'write',
            condition: { op: 'eq', left: { ref: 'user.bogusAttr' }, right: { lit: 'x' } },
          },
        ],
      });
      const sim = await pdp.simulateExplain({
        projectId: PROJECT,
        userId: 'u',
        subject: 'deals',
        action: 'write',
        recordId: 'rec-1',
        record: { stage: 'won' },
      });
      expect(sim.decision).toBe('deny');
      // The ABAC layer caught the AbacError and fail-closed.
      expect(sim.trace.some((s) => s.layer === 'abac' && s.effect === 'deny')).toBe(true);
    });

    it('ABAC eval error: uncompilable / malformed condition → fail-closed deny', async () => {
      const pdp = buildPdp({
        users: { u: { allow: ['deals:write'], role: 'member', member: 'member' } },
        catalogKeys,
        modulePolicies: [
          {
            id: 'r-malformed',
            moduleId: 'deals',
            effect: 'deny',
            subject: 'deals',
            action: 'write',
            // right operand has neither {ref} nor {lit} → parseAbac throws MALFORMED_NODE.
            condition: { op: 'eq', left: { ref: 'record.stage' }, right: {} },
          },
        ],
      });
      const sim = await pdp.simulateExplain({
        projectId: PROJECT,
        userId: 'u',
        subject: 'deals',
        action: 'write',
        recordId: 'rec-1',
        record: { stage: 'won' },
      });
      expect(sim.decision).toBe('deny');
      expect(sim.trace.some((s) => s.layer === 'abac' && s.effect === 'deny')).toBe(true);
    });
  });
});
