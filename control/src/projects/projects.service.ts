import { Injectable } from '@nestjs/common';
import {
  newEntityId,
  validateModuleIds,
  ensureLockedModules,
  normalizeModuleConfigs,
  extractEnabledModulesFromConfigs,
  resolveDependencies,
  assertCanDisable,
  enabledDependentsOf,
  isModuleLocked,
  ModuleLifecycleError,
  LIFECYCLE_ERROR,
  validatePolicyRules,
  normalizeVisibilityConfig,
  normalizeVisibilityConfigV2,
  effectiveVisibilityLevel,
  effectiveVisibilityPolicy,
  visibilityPolicyHasAll,
  VISIBILITY_LEVEL_RANK,
  isProjectRole,
  projectRoleCan,
  orgRoleCanManage,
  type JsonValue,
  type ProjectModuleConfig,
  type ProjectModulePolicyRule,
  type ProjectVisibilityConfigV2,
  syncModuleRuntimeAxes,
  readRuntimeStatus,
  type DlqResumeFate,
} from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectProvisioningService } from '../provisioning/project-provisioning.service';
import { AutomationLifecycleService } from '../provisioning/automation-lifecycle.service';
import { AppError } from '@fairflow/shared';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { RoleAuditService } from '../outbox/role-audit.service';
import { MemberOwnedRecordsService } from './member-owned-records.service';

type ProjectRow = {
  id: string;
  ownerId: string;
  name: string;
  templateId: string | null;
  modules: string[];
  moduleConfigs: unknown;
  modulePolicies: unknown;
  visibilityConfig: unknown;
  isArchived: boolean;
  status?: string;
  deletionScheduledAt?: Date | null;
  provisioningStatus?: string;
  createdAt: Date;
  updatedAt: Date;
};

/** C5: project lifecycle states. `purged` is the terminal tombstone (P2.e). */
export type ProjectStatus = 'active' | 'archived' | 'pending_deletion' | 'purged';
/** Grace window before a pending-deletion project may be purged (FR-MPRJ-17). */
const DELETION_GRACE_DAYS = 30;

/**
 * Модули, которые «Наполнить демо» демонстрирует и без которых демо-данные
 * не видны в UI. Демо-сид (pipe) раскладывает сделки/компании/контакты/продукты/
 * продажи/активности/автоправила, а дашборд и «Статистика» гейтятся модулем
 * `statistics` (иначе BFF отдаёт 403 MODULE_DISABLED → экран пуст). Поэтому при
 * запросе демо мы объединяем выбранные пользователем модули с этим набором —
 * иначе seeding кладёт данные, которые показать нечем. `deals` — locked, здесь
 * не нужен. Зависимости доразрешаются `normalizeModuleConfigs`/resolveDependencies.
 */
const DEMO_SHOWCASE_MODULES = [
  'statistics',
  'contacts',
  'companies',
  'products',
  'orders',
  'activities',
  'automation',
];

/** Сколько сотрудников организации подключить к демо-проекту как участников. */
const DEMO_ORG_MEMBER_LIMIT = 5;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioning: ProjectProvisioningService,
    private readonly automationLifecycle: AutomationLifecycleService,
    private readonly events: ControlEventEmitter,
    private readonly roleAudit: RoleAuditService,
    private readonly ownedRecords: MemberOwnedRecordsService,
  ) {}

  /**
   * C5 (defence-in-depth PEP): the actor must hold `manage` (owner/admin) in
   * THIS project. Fail-closed — empty actor OR non-member ⇒ denied; the check is
   * NEVER skipped "because actor is empty". This guards membership/lifecycle
   * mutations even if the gateway guard is bypassed or x-user-id is dropped.
   * Scoped strictly by (projectId, actor) — no cross-project escalation.
   */
  async assertCanManage(projectId: string, actorUserId?: string): Promise<void> {
    if (!projectId.trim()) throw new AppError('invalid', 'projectId required');
    const actor = (actorUserId ?? '').trim();
    if (!actor) throw new AppError('auth', 'Authentication required');
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: actor } },
      select: { role: true },
    });
    if (!projectRoleCan(member?.role, 'manage')) {
      throw new AppError('access', 'Managing this project requires project manage rights');
    }
  }

  /**
   * FR-PROJ-120: archived / pending_deletion projects are read-only for ordinary
   * mutations. Lifecycle transitions (archive, restore, request-deletion) bypass
   * this check in their own methods.
   */
  async assertProjectWritable(projectId: string): Promise<void> {
    const row = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true },
    });
    if (!row) throw new AppError('notFound', 'Project not found');
    const status = (row.status ?? 'active') as ProjectStatus;
    if (status !== 'active') {
      throw new AppError('locked', 'Project is read-only in its current lifecycle phase', {
        reason: 'PROJECT_READ_ONLY',
        status,
      });
    }
  }

  private normalizePolicyRules(raw: unknown): ProjectModulePolicyRule[] {
    if (!Array.isArray(raw)) return [];
    const rules: ProjectModulePolicyRule[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (
        typeof rec.id !== 'string' ||
        typeof rec.moduleId !== 'string' ||
        typeof rec.effect !== 'string' ||
        typeof rec.subject !== 'string' ||
        typeof rec.action !== 'string' ||
        typeof rec.resource !== 'string'
      ) {
        continue;
      }
      rules.push({
        id: rec.id,
        moduleId: rec.moduleId,
        effect: rec.effect === 'deny' ? 'deny' : 'allow',
        subject: rec.subject,
        action: rec.action,
        resource: rec.resource,
        condition:
          rec.condition && typeof rec.condition === 'object' && !Array.isArray(rec.condition)
            ? (rec.condition as Record<string, JsonValue>)
            : {},
      });
    }
    return rules;
  }

  private enrichProject(project: ProjectRow) {
    const normalizedConfigs = normalizeModuleConfigs(project.modules ?? [], project.moduleConfigs);
    const effectiveModules = extractEnabledModulesFromConfigs(normalizedConfigs);
    return {
      ...project,
      provisioningStatus: project.provisioningStatus ?? 'complete',
      moduleConfigs: normalizedConfigs,
      modulePolicies: this.normalizePolicyRules(project.modulePolicies),
      visibilityConfig: normalizeVisibilityConfigV2(project.visibilityConfig),
      effectiveModules,
      modules: ensureLockedModules(validateModuleIds(project.modules ?? effectiveModules)),
    };
  }

  async create(data: {
    ownerId: string;
    name: string;
    templateId?: string;
    modules?: string[];
    moduleConfigs?: ProjectModuleConfig[];
    modulePolicies?: ProjectModulePolicyRule[];
    createdByUserId?: string;
    seedDemoData?: boolean;
  }) {
    // Д-7 (инвариант): проект не может существовать без владельца. Создатель
    // обязателен — gateway всегда проставляет `x-user-id` из JWT. Пустой
    // `createdByUserId` = fail-closed, иначе получился бы «ничей» проект.
    const ownerUserId = data.createdByUserId?.trim();
    if (!ownerUserId) {
      throw new AppError('auth', 'createdByUserId required: a project must have an owner');
    }
    // DEORG-W1: box — single-tenant, личного вектора нет. Владелец проекта всегда
    // Система (`ownerId` = SYSTEM_ID, приходит с сервера). Единственный fail-closed
    // путь — IDOR-проверка: проект может создать только активный owner/admin Системы.
    const membership = await this.prisma.employee.findUnique({
      where: {
        organizationId_userId: { organizationId: data.ownerId, userId: ownerUserId },
      },
      select: { role: true, isActive: true },
    });
    if (!membership?.isActive || !orgRoleCanManage(membership.role)) {
      throw new AppError(
        'access',
        'Creating a project in this organization requires org owner/admin rights',
      );
    }
    // Демо-наполнение бессмысленно без модулей, которыми его показывают: объединяем
    // выбранные модули с демо-набором (в первую очередь `statistics` — иначе
    // дашборд/«Статистика» отдают 403 MODULE_DISABLED и экран пуст).
    const requestedModules = data.seedDemoData
      ? [...(data.modules ?? []), ...DEMO_SHOWCASE_MODULES]
      : (data.modules ?? []);
    const normalizedConfigs = normalizeModuleConfigs(requestedModules, data.moduleConfigs ?? []);
    const modules = extractEnabledModulesFromConfigs(normalizedConfigs);
    // Итоговый набор включённых модулей проекта (после каскада + locked-модули).
    // Это же значение управляет тем, инстанцируются ли типы продаж (FR-ONB-7).
    const effectiveModules = ensureLockedModules(validateModuleIds(modules));
    const policyCheck = validatePolicyRules(this.normalizePolicyRules(data.modulePolicies ?? []));
    // Демо + организация: подключаем несколько активных сотрудников организации
    // как участников проекта, чтобы демонстрировать распределение/видимость
    // (ответственные, коллеги). Для ЛИЧНОГО проекта осмысленных «других»
    // пользователей нет — единственный участник владелец (демо-записи назначаются
    // на него). Плодить фиктивные аккаунты в auth ради демо мы не хотим.
    let demoAssigneeIds: string[] = [];
    if (data.seedDemoData && data.ownerId) {
      try {
        const employees = await this.prisma.employee.findMany({
          where: { organizationId: data.ownerId, isActive: true, userId: { not: ownerUserId } },
          select: { userId: true },
          take: DEMO_ORG_MEMBER_LIMIT,
        });
        demoAssigneeIds = employees.map((e) => e.userId).filter(Boolean);
      } catch {
        // Best-effort: не смогли перечислить сотрудников — демо на одном владельце.
        demoAssigneeIds = [];
      }
    }
    // Д-7: Project + ProjectMember(owner) создаются АТОМАРНО в одной PG-транзакции.
    // Сбой добавления owner откатывает создание проекта целиком — состояния
    // «проект без owner» не существует.
    const project = await this.prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          id: newEntityId(),
          ownerId: data.ownerId,
          name: data.name,
          templateId: data.templateId,
          modules: effectiveModules,
          moduleConfigs: normalizedConfigs as unknown as object,
          modulePolicies: policyCheck.valid as unknown as object,
          provisioningStatus: 'pending',
        },
      });
      // upsert сохраняет идемпотентность относительно повторного добавления
      // того же владельца (шаблоны/инстанцирование проектов, E4-33).
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: created.id, userId: ownerUserId } },
        create: {
          id: newEntityId(),
          projectId: created.id,
          userId: ownerUserId,
          role: 'owner',
        },
        update: { role: 'owner' },
      });
      // Демо-участники (сотрудники организации) — роль member, идемпотентно.
      for (const memberId of demoAssigneeIds) {
        await tx.projectMember.upsert({
          where: { projectId_userId: { projectId: created.id, userId: memberId } },
          create: {
            id: newEntityId(),
            projectId: created.id,
            userId: memberId,
            role: 'member',
          },
          update: {},
        });
      }
      return created;
    });
    const enriched = this.enrichProject(project as unknown as ProjectRow);
    void this.runTemplateProvisioning(
      project.id,
      project.templateId,
      effectiveModules,
      data.seedDemoData ? { ownerId: ownerUserId, assigneeIds: demoAssigneeIds } : undefined,
    );
    return enriched;
  }

  /** FR-PROJ-095: track provisioning status instead of swallowing failures. */
  private async runTemplateProvisioning(
    projectId: string,
    templateId?: string | null,
    enabledModules: string[] = [],
    seedDemo?: { ownerId: string; assigneeIds?: string[] },
  ): Promise<void> {
    try {
      const ok = await this.provisioning.provisionFromTemplate(
        projectId,
        templateId,
        enabledModules,
        seedDemo,
      );
      await this.prisma.project.update({
        where: { id: projectId },
        data: { provisioningStatus: ok ? 'complete' : 'failed' },
      });
    } catch {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { provisioningStatus: 'failed' },
      });
    }
  }

  async findByOwner(ownerId: string) {
    const rows = await this.prisma.project.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.enrichProject(row as unknown as ProjectRow));
  }

  /** All projects accessible by user: member of project (any owner) */
  async findMyProjects(userId: string) {
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    const ids = memberships.map((m) => m.projectId);
    if (ids.length === 0) return [];
    const rows = await this.prisma.project.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.enrichProject(row as unknown as ProjectRow));
  }

  async findOne(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: { members: true },
    });
    if (!project) throw new AppError('notFound', 'Project not found');
    return this.enrichProject(project as unknown as ProjectRow & { members: unknown[] });
  }

  /**
   * TODO-237: carry the persisted LIFECYCLE state (`installed` / `version`) over
   * an incoming config list that does not mention it.
   *
   * `UpdateProject` is a full-list PATCH: the FE round-trips every module config
   * on every save. Before this merge, a client that did not know about the
   * lifecycle fields (or a proto3 wire that cannot express `installed:false`)
   * wiped the install fact and the active version that install/upgrade had
   * written — `normalizeModuleConfigs` then re-derived `installed` from
   * `enabled` and the version was gone for good.
   *
   * Semantics are additive on purpose: an incoming `installed:true` / non-empty
   * `version` wins, `undefined` inherits the stored value. Clearing the install
   * fact is not expressible here — that is `ModuleLifecycleService.uninstall`,
   * which passes an explicit `installed: false` (a real boolean, not
   * `undefined`) and therefore still wins.
   *
   * The merge is a UNION, not a replacement: a module the caller did not mention
   * keeps its stored row. Otherwise a PATCH that sends only the modules it wants
   * to change would drop every other config — the install fact, the version and
   * the personal/integration settings of a disabled-but-installed module.
   */
  private mergeLifecycleState(
    prev: ProjectModuleConfig[],
    incoming: ProjectModuleConfig[],
  ): ProjectModuleConfig[] {
    const incomingById = new Map(incoming.map((c) => [c.moduleId, c]));
    const withLifecycle = (
      cfg: ProjectModuleConfig,
      before: ProjectModuleConfig,
    ): ProjectModuleConfig => {
      const version = cfg.version ?? before.version;
      return {
        ...cfg,
        installed: cfg.installed ?? before.installed,
        ...(version ? { version } : {}),
        runtimeStatus: cfg.runtimeStatus ?? before.runtimeStatus,
        everSuspended: cfg.everSuspended ?? before.everSuspended,
        configState: cfg.configState ?? before.configState,
      };
    };
    const seen = new Set<string>();
    const merged: ProjectModuleConfig[] = [];
    for (const before of prev) {
      const cfg = incomingById.get(before.moduleId);
      merged.push(cfg ? withLifecycle(cfg, before) : before);
      seen.add(before.moduleId);
    }
    for (const cfg of incoming) {
      if (!seen.has(cfg.moduleId)) merged.push(cfg);
    }
    return merged;
  }

  /** Enabled module ids of a normalized config list. */
  private enabledSet(configs: ProjectModuleConfig[]): Set<string> {
    return new Set(configs.filter((c) => c.enabled).map((c) => c.moduleId));
  }

  /** Installed module ids (enabled ⇒ installed, lifecycle invariant). */
  private installedSet(configs: ProjectModuleConfig[]): Set<string> {
    return new Set(configs.filter((c) => c.enabled || c.installed).map((c) => c.moduleId));
  }

  /**
   * The enabled set the CALLER asked for, before `normalizeModuleConfigs`
   * applies its dependency cascade. Mirrors the normalizer's own precedence:
   * `modules[]` (plus their dependencies) seeds the set, an explicit config
   * entry then overrides it either way.
   */
  private requestedEnabledSet(
    configs: ProjectModuleConfig[],
    modules: string[] | undefined,
  ): Set<string> {
    const requested = new Set<string>(resolveDependencies(modules ?? []));
    for (const cfg of configs) {
      if (cfg.enabled) requested.add(cfg.moduleId);
      else requested.delete(cfg.moduleId);
    }
    return requested;
  }

  /**
   * TODO-240: refuse to silently cascade-disable dependants.
   *
   * `normalizeModuleConfigs` used to walk the dependency graph to a fixed point
   * and quietly switch off every module that depended on the one being
   * disabled — the user asked to turn off ONE module and lost several, with no
   * signal at all. The lifecycle state machine already knows the rule
   * (`assertCanDisable` → `DEPENDENTS_ENABLED`) but nothing called it.
   *
   * Now: for every module that goes enabled → disabled in THIS request, if a
   * module that depends on it is still requested enabled, the whole save is
   * rejected with `locked` + the dependant list (the FE shows it and lets the
   * user disable them explicitly). Disabling a dependency together with its
   * dependants in one request is accepted — the dependants are no longer in the
   * requested set. Locked/system modules are skipped: the normalizer keeps them
   * enabled regardless, so a stray `enabled:false` for `deals` is not an error.
   */
  private assertNoSilentCascade(
    prevConfigs: ProjectModuleConfig[],
    nextConfigs: ProjectModuleConfig[],
    modules: string[] | undefined,
  ): void {
    const prevEnabled = this.enabledSet(prevConfigs);
    const requestedEnabled = this.requestedEnabledSet(nextConfigs, modules);
    const ctx = { installed: this.installedSet(prevConfigs), enabled: requestedEnabled };
    for (const moduleId of prevEnabled) {
      if (requestedEnabled.has(moduleId)) continue;
      if (isModuleLocked(moduleId)) continue;
      try {
        assertCanDisable(moduleId, ctx);
      } catch (err) {
        if (
          err instanceof ModuleLifecycleError &&
          err.code === LIFECYCLE_ERROR.DEPENDENTS_ENABLED
        ) {
          const dependents = (err.details?.dependents as string[] | undefined) ?? [];
          throw new AppError('conflict', 'MODULE_HAS_DEPENDENTS', {
            code: 'MODULE_HAS_DEPENDENTS',
            moduleId,
            dependents,
          });
        }
        throw err;
      }
    }
  }

  /**
   * TODO-239: the module-lifecycle transitions this save performs, as audit
   * facts. Every enable/disable/install/uninstall/upgrade is an access- and
   * billing-relevant change of what the project can do, and none of them
   * reached the audit chain or the bus before (the `control.module.*`
   * routing-keys existed but had zero emitters).
   */
  private moduleLifecycleFacts(
    prevConfigs: ProjectModuleConfig[],
    nextConfigs: ProjectModuleConfig[],
    runtimeResume?: { moduleId: string; dlq: DlqResumeFate },
  ): Array<{
    action: string;
    routingKey: string;
    moduleId: string;
    before: unknown;
    after: unknown;
  }> {
    const facts: Array<{
      action: string;
      routingKey: string;
      moduleId: string;
      before: unknown;
      after: unknown;
    }> = [];
    const prevById = new Map(prevConfigs.map((c) => [c.moduleId, c]));
    const prevEnabled = this.enabledSet(prevConfigs);
    const prevInstalled = this.installedSet(prevConfigs);
    const nextEnabled = this.enabledSet(nextConfigs);
    const nextInstalled = this.installedSet(nextConfigs);

    for (const cfg of nextConfigs) {
      const moduleId = cfg.moduleId;
      const before = prevById.get(moduleId);
      if (nextInstalled.has(moduleId) && !prevInstalled.has(moduleId)) {
        facts.push({
          action: 'module.installed',
          routingKey: 'control.module.installed',
          moduleId,
          before: null,
          after: { moduleId, version: cfg.version ?? null },
        });
      }
      if (nextEnabled.has(moduleId) && !prevEnabled.has(moduleId)) {
        facts.push({
          action: 'module.enabled',
          routingKey: 'control.module.enabled',
          moduleId,
          before: { moduleId, enabled: false },
          after: { moduleId, enabled: true },
        });
      }
      if (!nextEnabled.has(moduleId) && prevEnabled.has(moduleId)) {
        facts.push({
          action: 'module.disabled',
          routingKey: 'control.module.disabled',
          moduleId,
          before: { moduleId, enabled: true },
          after: { moduleId, enabled: false },
        });
      }
      if (
        before?.version &&
        cfg.version &&
        before.version !== cfg.version &&
        nextInstalled.has(moduleId)
      ) {
        facts.push({
          action: 'module.upgraded',
          routingKey: 'control.module.upgraded',
          moduleId,
          before: { moduleId, version: before.version },
          after: { moduleId, version: cfg.version },
        });
      }
      const prevRuntime = before ? readRuntimeStatus(before) : 'suspended';
      const nextRuntime = readRuntimeStatus(cfg);
      if (nextEnabled.has(moduleId) && prevRuntime === 'suspended' && nextRuntime === 'active') {
        const pending = runtimeResume?.moduleId === moduleId ? runtimeResume.dlq : undefined;
        facts.push({
          action: 'module.runtime_resumed',
          routingKey: 'control.module.runtime_resumed',
          moduleId,
          before: { moduleId, runtimeStatus: 'suspended' },
          after: { moduleId, runtimeStatus: 'active', ...(pending ? { dlq: pending } : {}) },
        });
      }
    }
    // Uninstall drops the module from the list entirely, so it is only visible
    // by walking the PREVIOUS configs.
    for (const moduleId of prevInstalled) {
      if (nextInstalled.has(moduleId)) continue;
      facts.push({
        action: 'module.uninstalled',
        routingKey: 'control.module.uninstalled',
        moduleId,
        before: { moduleId, version: prevById.get(moduleId)?.version ?? null },
        after: null,
      });
    }
    return facts;
  }

  /**
   * FR-PSET-055: when `cascade` is true, expand the disable set to all enabled
   * dependents of every module the caller is turning off in this request.
   */
  private expandCascadeDisable(
    prevConfigs: ProjectModuleConfig[],
    incomingConfigs: ProjectModuleConfig[],
    modules: string[] | undefined,
    cascade?: boolean,
  ): ProjectModuleConfig[] {
    if (!cascade) return incomingConfigs;
    const prevEnabled = this.enabledSet(prevConfigs);
    const requestedEnabled = this.requestedEnabledSet(incomingConfigs, modules);
    const disabling = [...prevEnabled].filter((id) => !requestedEnabled.has(id));
    if (disabling.length === 0) return incomingConfigs;

    const toDisable = new Set(disabling);
    const enabledAfter = new Set(requestedEnabled);
    const queue = [...disabling];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const ctx = { installed: this.installedSet(prevConfigs), enabled: enabledAfter };
      for (const dep of enabledDependentsOf(id, ctx)) {
        if (enabledAfter.has(dep)) {
          enabledAfter.delete(dep);
          toDisable.add(dep);
          queue.push(dep);
        }
      }
    }

    return incomingConfigs.map((cfg) =>
      toDisable.has(cfg.moduleId) ? { ...cfg, enabled: false } : cfg,
    );
  }

  async update(
    id: string,
    data: {
      name?: string;
      modules?: string[];
      moduleConfigs?: ProjectModuleConfig[];
      modulePolicies?: ProjectModulePolicyRule[];
      visibilityConfig?: ProjectVisibilityConfigV2;
      isArchived?: boolean;
      cascade?: boolean;
      /** FR-PLATFORM-115: per-request DLQ fate for the runtime_resumed audit fact. */
      runtimeResume?: { moduleId: string; dlq: DlqResumeFate };
      /**
       * BX-MODEL-6 (§7.3): opaque key of the access preset this save originates
       * from (set by the "Apply preset" flow). When present, a `preset.applied`
       * audit fact is chained in addition to the concrete config-change facts, so
       * the trail says WHY the levels changed, not just that they did.
       */
      appliedPreset?: string;
    },
    actorUserId?: string,
  ) {
    // TODO-085 (defence-in-depth PEP): `update` is the mutation that rewrites
    // modules / moduleConfigs / modulePolicies / visibilityConfig — i.e. it can
    // hand out or take away access across the whole project. It was the ONLY
    // project mutation without its own PEP (addMember/updateMemberRole/archive/
    // … all call this), so a caller that reached the domain with the gateway
    // guard bypassed could rewrite the access model. Fail-closed like the rest:
    // the actor must hold `manage` in THIS project, an empty actor is denied.
    // Internal callers (ModuleLifecycleService) thread the real actor through.
    await this.assertCanManage(id, actorUserId);
    await this.assertProjectWritable(id);
    const current = await this.findOne(id);
    const wasArchived = Boolean((current as unknown as ProjectRow).isArchived);
    const currentConfigs = (current.moduleConfigs ?? []) as ProjectModuleConfig[];
    // TODO-237: keep `installed`/`version` that the incoming PATCH does not carry.
    const mergedIncoming = this.mergeLifecycleState(
      currentConfigs,
      (data.moduleConfigs ?? currentConfigs) as ProjectModuleConfig[],
    );
    const incomingConfigs = this.expandCascadeDisable(
      currentConfigs,
      mergedIncoming,
      data.modules,
      data.cascade,
    );
    // TODO-240: an explicit refusal instead of a silent dependency cascade.
    this.assertNoSilentCascade(currentConfigs, incomingConfigs, data.modules);
    const normalized = normalizeModuleConfigs(data.modules ?? current.modules, incomingConfigs);
    const nextConfigs = syncModuleRuntimeAxes(currentConfigs, normalized);
    const nextModules = extractEnabledModulesFromConfigs(nextConfigs);
    // TODO-239: enable/disable/install/uninstall/upgrade → audit chain + bus.
    const lifecycleFacts = this.moduleLifecycleFacts(
      currentConfigs,
      nextConfigs,
      data.runtimeResume,
    );
    const nextPolicies =
      data.modulePolicies != null
        ? this.normalizePolicyRules(data.modulePolicies)
        : this.normalizePolicyRules(current.modulePolicies);
    const policyCheck = validatePolicyRules(nextPolicies);

    // P8 T5.2 (X-10): module-policy is an access-affecting fact that must reach the
    // audit chain. Emit only when the caller actually changed the policy set and it
    // differs from the stored one (avoid noise from unrelated project updates).
    const prevPoliciesJson = JSON.stringify(this.normalizePolicyRules(current.modulePolicies));
    const nextPoliciesJson = JSON.stringify(policyCheck.valid);
    const policyChanged = data.modulePolicies != null && prevPoliciesJson !== nextPoliciesJson;

    // BX-MODEL-6 (§7.3): record-visibility is an access-affecting fact that must
    // reach the tamper-evident access chain. Chain a `visibility.updated` audit
    // fact only when the caller actually changed the normalized level map (avoid
    // noise from unrelated project edits). Levels are role→level enums — no PII.
    const nextVisibility =
      data.visibilityConfig != null ? normalizeVisibilityConfigV2(data.visibilityConfig) : null;
    const prevVisibilityJson = JSON.stringify(
      normalizeVisibilityConfigV2(current.visibilityConfig),
    );
    const visibilityChanged =
      nextVisibility != null && JSON.stringify(nextVisibility) !== prevVisibilityJson;
    const appliedPreset = (data.appliedPreset ?? '').trim();

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.project.update({
        where: { id },
        data: {
          ...(data.name != null && { name: data.name }),
          modules: ensureLockedModules(validateModuleIds(nextModules)),
          moduleConfigs: nextConfigs as unknown as object,
          modulePolicies: policyCheck.valid as unknown as object,
          ...(data.visibilityConfig != null && {
            visibilityConfig: normalizeVisibilityConfigV2(
              data.visibilityConfig,
            ) as unknown as object,
          }),
          ...(data.isArchived != null && { isArchived: data.isArchived }),
        },
      });
      if (policyChanged) {
        await this.events.emit(tx, {
          routingKey: 'control.policy.updated',
          // Stable per (project, policy-set) so retries dedup; version by content.
          idempotencyKey: `control.policy.updated:${id}:${newEntityId()}`,
          projectId: id,
          actorUserId: actorUserId ?? null,
          entityType: 'module_policy',
          entityId: id,
          action: 'policy.updated',
          metadata: { ruleCount: policyCheck.valid.length },
        });
      }
      // Chain the visibility-change fact into the per-project access journal (same
      // writer/chain as role/member/share facts), atomically with the row update.
      if (visibilityChanged) {
        await this.roleAudit.append(tx, {
          projectId: id,
          actorUserId,
          action: 'visibility.updated',
          entityType: 'visibility_config',
          entityId: id,
          summary: 'record-visibility levels updated',
          before: current.visibilityConfig ?? null,
          after: nextVisibility,
          routingKey: 'control.visibility.changed',
        });
        const beforeCfg = normalizeVisibilityConfigV2(current.visibilityConfig);
        const rankFor = (
          role: 'owner' | 'admin' | 'manager',
          cfg: ReturnType<typeof normalizeVisibilityConfigV2>,
        ) => {
          const policy = effectiveVisibilityPolicy(role, cfg);
          if (visibilityPolicyHasAll(policy)) return 'all' as const;
          const entry = cfg[role];
          if (typeof entry === 'string') return entry;
          return 'only_own' as const;
        };
        for (const role of ['owner', 'admin', 'manager'] as const) {
          const from = rankFor(role, beforeCfg);
          const to = rankFor(role, nextVisibility!);
          if (VISIBILITY_LEVEL_RANK[to] < VISIBILITY_LEVEL_RANK[from]) {
            const holders = await tx.projectMember.findMany({
              where: { projectId: id, role },
              select: { userId: true },
            });
            await this.events.emit(tx, {
              routingKey: 'control.visibility.narrowed',
              idempotencyKey: `control.visibility.narrowed:${id}:${role}:${from}:${to}`,
              projectId: id,
              actorUserId: actorUserId ?? null,
              entityType: 'visibility_config',
              entityId: id,
              action: 'visibility.narrowed',
              metadata: {
                role,
                from,
                to,
                userIds: holders.map((h) => h.userId),
              },
            });
          }
        }
      }
      // TODO-239: one chained fact per module transition, in the SAME transaction
      // as the config write — the module composition of a project can no longer
      // change without a tamper-evident record + a bus projection.
      for (const fact of lifecycleFacts) {
        await this.roleAudit.append(tx, {
          projectId: id,
          actorUserId,
          action: fact.action,
          entityType: 'module',
          entityId: fact.moduleId,
          summary: `${fact.action} ${fact.moduleId}`,
          before: fact.before,
          after: fact.after,
          routingKey: fact.routingKey,
        });
      }
      // The "why": this save came from applying a named access preset. Chained
      // alongside the concrete facts above so the trail is legible (152-ФЗ).
      if (appliedPreset) {
        await this.roleAudit.append(tx, {
          projectId: id,
          actorUserId,
          action: 'preset.applied',
          entityType: 'access_preset',
          entityId: id,
          summary: `access preset "${appliedPreset}" applied`,
          before: null,
          after: { preset: appliedPreset },
          routingKey: 'control.preset.applied',
        });
      }
      return row;
    });
    const enriched = this.enrichProject(updated as unknown as ProjectRow);
    await this.automationLifecycle.syncModuleTransitions(
      id,
      lifecycleFacts,
      nextConfigs,
      nextModules,
    );
    await this.automationLifecycle.syncArchiveTransition(
      id,
      wasArchived,
      Boolean((enriched as unknown as ProjectRow).isArchived),
    );
    // FR-PSET-505: lazy provisioning when `orders` is enabled post-create.
    const prevEnabled = this.enabledSet(currentConfigs);
    const nextEnabled = this.enabledSet(nextConfigs);
    if (!prevEnabled.has('orders') && nextEnabled.has('orders')) {
      const row = current as unknown as ProjectRow;
      const templateId = row.templateId ?? '';
      void this.provisioning
        .provisionFromTemplate(id, templateId, nextModules)
        .catch(() => undefined);
    }
    return enriched;
  }

  /**
   * TODO-449 — patch `moduleConfigs[].personalSettings` for a single module inside
   * one DB transaction. Avoids the gateway RMW race where two concurrent saves
   * (Modules tab + search settings) each read the full project and the second
   * `updateProject` overwrote the first module's config.
   */
  async setModulePersonalSettings(
    projectId: string,
    moduleId: string,
    personalSettings: Record<string, unknown>,
    actorUserId?: string,
  ): Promise<Record<string, unknown>> {
    await this.assertCanManage(projectId, actorUserId);
    validateModuleIds([moduleId]);
    const settings =
      personalSettings && typeof personalSettings === 'object' && !Array.isArray(personalSettings)
        ? personalSettings
        : {};

    const updated = await this.prisma.$transaction(
      async (tx) => {
        const row = await tx.project.findUnique({ where: { id: projectId } });
        if (!row) throw new AppError('notFound', 'Project not found');
        const currentConfigs = (row.moduleConfigs ?? []) as ProjectModuleConfig[];
        const modules = Array.isArray(row.modules) ? row.modules : [];
        const merged = currentConfigs.map((c) =>
          c.moduleId === moduleId ? { ...c, personalSettings: settings } : c,
        );
        if (!merged.some((c) => c.moduleId === moduleId)) {
          merged.push({
            moduleId,
            enabled: modules.includes(moduleId),
            personalSettings: settings,
            integrationSettings: {},
            integrationMethodsEnabled: [],
          });
        }
        const nextConfigs = normalizeModuleConfigs(modules, merged);
        const nextModules = ensureLockedModules(
          validateModuleIds(extractEnabledModulesFromConfigs(nextConfigs)),
        );
        const saved = (await tx.project.update({
          where: { id: projectId },
          data: {
            modules: nextModules,
            moduleConfigs: nextConfigs as unknown as object,
          },
        })) as { moduleConfigs: unknown };
        const out = (saved.moduleConfigs as ProjectModuleConfig[]).find(
          (c) => c.moduleId === moduleId,
        );
        return out?.personalSettings ?? {};
      },
      { isolationLevel: 'Serializable' },
    );

    return updated as Record<string, unknown>;
  }

  /**
   * Paired read for `setModulePersonalSettings`: the gateway module-settings GET
   * routes must not fish personalSettings out of the full Project payload —
   * mapProject emits them as plain JSON, which the Struct serializer drops.
   * Access gating (project:manage vs member-readable projection) is enforced by
   * the gateway routes, same trust model as `getProject`.
   */
  async getModulePersonalSettings(
    projectId: string,
    moduleId: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!row) throw new AppError('notFound', 'Project not found');
    const configs = (row.moduleConfigs ?? []) as ProjectModuleConfig[];
    const cfg = configs.find((c) => c.moduleId === moduleId);
    return (cfg?.personalSettings ?? {}) as Record<string, unknown>;
  }

  /** FR-PRODUCTS-050: read integrationSettings for a module (project-level). */
  async getModuleIntegrationSettings(
    projectId: string,
    moduleId: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!row) throw new AppError('notFound', 'Project not found');
    const configs = (row.moduleConfigs ?? []) as ProjectModuleConfig[];
    const cfg = configs.find((c) => c.moduleId === moduleId);
    return (cfg?.integrationSettings ?? {}) as Record<string, unknown>;
  }

  async getMembers(projectId: string) {
    await this.findOne(projectId);
    return this.prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(projectId: string, userId: string, role: string, actorUserId?: string) {
    // FR-MPRJ-2/3/6: участник добавляется по известному userId; роль валидируется
    // по канону; upsert по (projectId,userId) — повтор обновляет роль, не дублит.
    // C5: fail-closed PEP — actor must hold `manage` in THIS project.
    await this.assertCanManage(projectId, actorUserId);
    await this.assertProjectWritable(projectId);
    if (!userId.trim()) throw new AppError('invalid', 'userId required');
    const normalizedRole = isProjectRole(role) ? role : 'viewer';
    await this.findOne(projectId);
    // S6: membership + role write and its audit row commit in ONE transaction —
    // a role write is impossible without an audit line (no "silent" add/role-set).
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { role: true },
      });
      const upserted = await tx.projectMember.upsert({
        where: { projectId_userId: { projectId, userId } },
        create: { id: newEntityId(), projectId, userId, role: normalizedRole },
        update: { role: normalizedRole },
      });
      await this.roleAudit.append(tx, {
        projectId,
        actorUserId,
        action: 'member.added',
        entityType: 'project_member',
        entityId: upserted.id,
        summary: `member ${userId} set to role "${normalizedRole}"`,
        before: existing ? { userId, role: existing.role } : null,
        after: { userId, role: normalizedRole },
      });
      return upserted;
    });
  }

  async updateMemberRole(projectId: string, userId: string, role: string, actorUserId?: string) {
    // C5: fail-closed PEP — actor must hold `manage` in THIS project.
    await this.assertCanManage(projectId, actorUserId);
    await this.assertProjectWritable(projectId);
    if (!isProjectRole(role)) throw new AppError('invalid', `Invalid project role "${role}"`);
    // FR-MPRJ-4/6: проверка «не последний owner» И мутация — в ОДНОЙ транзакции
    // (защита от гонки двух параллельных понижений). Целевой участник ищется
    // строго по (projectId,userId) — изоляция x-project-id.
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
      });
      if (!member) throw new AppError('notFound', 'Member not found');
      const beforeRole = member.role;
      // Д-7 (инвариант): нельзя осиротить проект — понижение последнего owner запрещено.
      if (member.role === 'owner' && role !== 'owner') {
        const owners = await tx.projectMember.count({
          where: { projectId, role: 'owner' },
        });
        if (owners <= 1) {
          throw new AppError('locked', 'Cannot demote the last owner of the project', {
            reason: 'LAST_OWNER',
          });
        }
      }
      const updated = await tx.projectMember.update({
        where: { projectId_userId: { projectId, userId } },
        data: { role },
      });
      // S6 ("silent role change" fix): the role write is impossible without an
      // audit line in the SAME transaction — a failed audit rolls the change back
      // (NOT best-effort). The outbox event (control.role.assigned) is emitted in
      // the same tx so the audit chain receives the change. The LAST_OWNER guard
      // above throws BEFORE this point, so a rejected demote emits nothing.
      await this.roleAudit.append(tx, {
        projectId,
        actorUserId,
        action: 'member_role.changed',
        entityType: 'project_member',
        entityId: member.id,
        summary: `member ${userId} role "${beforeRole}" → "${role}"`,
        before: { userId, role: beforeRole },
        after: { userId, role },
      });
      return updated;
    });
  }

  async previewRemoveMember(projectId: string, userId: string, actorUserId?: string) {
    await this.assertCanManage(projectId, actorUserId);
    const project = await this.findOne(projectId);
    const modules =
      (project as { effectiveModules?: string[] }).effectiveModules ??
      (project as { modules?: string[] }).modules ??
      [];
    const { total, breakdown } = await this.ownedRecords.countOwned(projectId, userId, modules);
    return { ownedCount: total, breakdown };
  }

  async removeMember(
    projectId: string,
    userId: string,
    actorUserId?: string,
    reassignToUserId?: string,
  ) {
    // FR-MPRJ-4/6: «не последний owner» + удаление атомарно; скоуп по projectId.
    // C5: fail-closed PEP — actor must hold `manage` in THIS project.
    await this.assertCanManage(projectId, actorUserId);
    await this.assertProjectWritable(projectId);
    const project = await this.findOne(projectId);
    const modules =
      (project as { effectiveModules?: string[] }).effectiveModules ??
      (project as { modules?: string[] }).modules ??
      [];
    const { total } = await this.ownedRecords.countOwned(projectId, userId, modules);
    const reassignTo = (reassignToUserId ?? '').trim();
    if (total > 0 && !reassignTo) {
      throw new AppError(
        'conflict',
        'Member has owned records; reassign ownership before removal',
        { reason: 'OWNED_RECORDS', ownedCount: total },
      );
    }
    if (total > 0 && reassignTo) {
      if (reassignTo === userId) {
        throw new AppError('invalid', 'Cannot reassign records to the member being removed');
      }
      const targetMember = await this.prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: reassignTo } },
      });
      if (!targetMember) {
        throw new AppError('invalid', 'Reassign target must be an active project member');
      }
      await this.ownedRecords.reassignOwned(projectId, userId, reassignTo, modules);
    }
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
      });
      if (!member) return { ok: true };
      if (member.role === 'owner') {
        const owners = await tx.projectMember.count({
          where: { projectId, role: 'owner' },
        });
        if (owners <= 1) {
          throw new AppError('locked', 'Cannot remove the last owner of the project', {
            reason: 'LAST_OWNER',
          });
        }
      }
      await tx.projectMember.deleteMany({ where: { projectId, userId } });
      // S6: the membership removal (a role revocation) commits with its audit line
      // in the same tx; emits control.role.revoked. LAST_OWNER throws above ⇒ no emit.
      await this.roleAudit.append(tx, {
        projectId,
        actorUserId,
        action: 'member.removed',
        entityType: 'project_member',
        entityId: member.id,
        summary: `member ${userId} (role "${member.role}") removed`,
        before: { userId, role: member.role },
        after: null,
      });
      return { ok: true };
    });
  }

  /**
   * US-MPRJ-17: архивация/разархивация проекта.
   * C5: ведёт статус жизненного цикла (active|archived) синхронно с isArchived.
   * Fail-closed PEP — actor must hold `manage`.
   */
  async setArchived(projectId: string, isArchived: boolean, actorUserId?: string) {
    await this.assertCanManage(projectId, actorUserId);
    const current = await this.findOne(projectId);
    const wasArchived = Boolean((current as unknown as ProjectRow).isArchived);
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        isArchived,
        // archive ⇒ "archived"; unarchive ⇒ back to "active" (clears any
        // pending-deletion schedule).
        status: isArchived ? 'archived' : 'active',
        ...(isArchived ? {} : { deletionScheduledAt: null }),
      },
    });
    const enriched = this.enrichProject(updated as unknown as ProjectRow);
    await this.automationLifecycle.syncArchiveTransition(projectId, wasArchived, isArchived);
    return enriched;
  }

  /**
   * C5 (FR-MPRJ-17): soft delete — move the project to `pending_deletion` with a
   * grace window. Reversible via {@link restore} until purge. Fail-closed PEP.
   * Transition guard: a project must be archived (or active) — already
   * pending_deletion is idempotent (returns current schedule).
   */
  async requestDeletion(projectId: string, actorUserId?: string, confirmName?: string) {
    await this.assertCanManage(projectId, actorUserId);
    const current = await this.findOne(projectId);
    if (confirmName != null) {
      const expected = ((current as unknown as ProjectRow).name ?? '').trim();
      if (confirmName.trim() !== expected) {
        throw new AppError('invalid', 'Project name confirmation does not match');
      }
    }
    if ((current as unknown as ProjectRow).status === 'pending_deletion') {
      return current; // idempotent — already scheduled
    }
    const scheduledAt = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'pending_deletion', isArchived: true, deletionScheduledAt: scheduledAt },
    });
    return this.enrichProject(updated as unknown as ProjectRow);
  }

  /**
   * C5: restore a project from `archived`/`pending_deletion` back to `active`,
   * clearing any purge schedule. Fail-closed PEP.
   */
  async restore(projectId: string, actorUserId?: string) {
    await this.assertCanManage(projectId, actorUserId);
    const current = await this.findOne(projectId);
    const wasArchived = Boolean((current as unknown as ProjectRow).isArchived);
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'active', isArchived: false, deletionScheduledAt: null },
    });
    const enriched = this.enrichProject(updated as unknown as ProjectRow);
    await this.automationLifecycle.syncArchiveTransition(projectId, wasArchived, false);
    return enriched;
  }

  /**
   * C5 (FR-ONB-5/7): (re)apply an onboarding template to an existing project —
   * (re)provisions pipeline/order-types in pipe/orders for the project's current
   * effective modules. Idempotent (domains upsert by unique index). Optionally
   * sets the project's templateId. Fail-closed PEP — actor must hold `manage`.
   */
  async applyTemplate(projectId: string, templateId: string, actorUserId?: string) {
    await this.assertCanManage(projectId, actorUserId);
    await this.assertProjectWritable(projectId);
    const project = await this.findOne(projectId);
    const tmpl = templateId.trim() || (project as unknown as ProjectRow).templateId || '';
    if (!tmpl) throw new AppError('invalid', 'templateId required');
    // Persist templateId so lazy domain seeding picks it up (FR-ONB-9).
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { templateId: tmpl },
    });
    const enriched = this.enrichProject(updated as unknown as ProjectRow);
    // Best-effort, idempotent provisioning for the project's effective modules.
    await this.provisioning.provisionFromTemplate(projectId, tmpl, enriched.effectiveModules);
    return enriched;
  }

  /** FR-PROFILE-280: aggregate memberships with role + effective visibility level. */
  async getMyAccess(userId: string) {
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      include: { project: true },
      orderBy: { createdAt: 'desc' },
    });
    return memberships.map((m) => {
      const rawConfig = (m.project as { visibilityConfig?: unknown }).visibilityConfig;
      const config = normalizeVisibilityConfig(rawConfig);
      const visibilityLevel = effectiveVisibilityLevel(m.role, config);
      return {
        projectId: m.projectId,
        projectName: m.project.name,
        role: m.role,
        visibilityLevel,
        joinedAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
      };
    });
  }

  /** For other services: check if user has at least the given role in project */
  async checkAccess(
    projectId: string,
    userId: string,
  ): Promise<{ allowed: boolean; role?: string }> {
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (!member) return { allowed: false };
    return { allowed: true, role: member.role };
  }
}
