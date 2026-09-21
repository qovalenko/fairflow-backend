import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { ObjectId } from 'mongodb';
import {
  buildOwnableVisibilityFilter,
  evalGate,
  isOwnableRecordVisible,
  type AbacNode,
  type AccessPredicate,
  type EmitIntent,
  type VisibilityScope,
} from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService } from './project-members.service';

const OWNER_FIELD = 'assigneeId';
/** FIELD-ACT-departmentId (W-6): второй ключ владения рядом с OWNER_FIELD. */
const DEPARTMENT_FIELD = 'departmentId';
const TYPES = ['task', 'call', 'meeting', 'note'];
const STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'];
const DIRECTIONS = ['inbound', 'outbound'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const LINK_TYPES = ['deal', 'order', 'contact', 'company'];
const REMINDER_OFFSETS = ['none', 'at_time', '15m', '1h', '1d'];
const TERMINAL = ['completed', 'cancelled'];
const SORT_FIELDS: Record<string, string> = {
  dueDate: 'dueDate',
  due_date: 'dueDate',
  title: 'title',
  createdAt: 'createdAt',
  created_at: 'createdAt',
  updatedAt: 'updatedAt',
  updated_at: 'updatedAt',
  status: 'status',
  priority: 'priority',
};
const CALENDAR_MAX_ROWS = 5000;

type Link = { entityType: string; entityId: string; nameSnapshot?: string; orphaned?: boolean };

/** Escape user input before using it inside a RegExp (avoids ReDoS / injection, #22). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function invalid(message: string, field?: string): never {
  throw new RpcException({
    code: status.INVALID_ARGUMENT,
    message: field ? `${message} (${field})` : message,
  });
}
function notFound(): never {
  throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
}
function denied(message: string): never {
  throw new RpcException({ code: status.PERMISSION_DENIED, message });
}
function precondition(message: string): never {
  throw new RpcException({ code: status.FAILED_PRECONDITION, message });
}

/** Reminder offset → ms before the anchor (dueDate). 'none'/'at_time' → 0. */
function reminderOffsetMs(offset?: string): number {
  switch (offset) {
    case '15m':
      return 15 * 60_000;
    case '1h':
      return 60 * 60_000;
    case '1d':
      return 24 * 60 * 60_000;
    default:
      return 0;
  }
}

@Injectable()
export class ActivityService {
  private static readonly DENY_ALL_ID = new ObjectId('000000000000000000000000');

  constructor(
    private readonly mongo: MongoService,
    private readonly outbox: MongoOutboxStore,
    private readonly nameResolver: NameResolverService,
    private readonly projectMembers: ProjectMembersService,
  ) {}

  /**
   * Base payload shared by every `crm.activity.*` event (RFC-4 §5, M2/FR-18).
   * FR-ACTIVITIES-290 needs `title`, `dueDate` and `links[].nameSnapshot` on the
   * wire so notification can render title/type/привязка/срок without a follow-up read.
   */
  private eventBase(doc: Record<string, unknown>) {
    const links = (Array.isArray(doc.links) ? doc.links : []) as Link[];
    return {
      projectId: String(doc.projectId ?? ''),
      activityId: (doc._id as ObjectId).toString(),
      type: String(doc.type ?? 'task'),
      title: String(doc.title ?? ''),
      dueDate: doc.dueDate == null ? null : Number(doc.dueDate),
      assigneeId: String(doc.assigneeId ?? ''),
      // FIELD-ACT-departmentId (W-6): подписчики (reports/search/notification)
      // раскладывают активности по подразделениям — без поля в payload им пришлось
      // бы дочитывать домен на каждое событие.
      departmentId:
        doc.departmentId == null || doc.departmentId === '' ? null : String(doc.departmentId),
      links: links.map((l) => ({
        entityType: l.entityType,
        entityId: l.entityId,
        nameSnapshot: l.nameSnapshot ?? '',
        orphaned: !!l.orphaned,
      })),
    };
  }

  /** Record ids shared with the viewer (resolved upstream), as ObjectIds. */
  private sharedObjectIds(scope?: VisibilityScope): ObjectId[] {
    if (!scope) return [];
    return scope.sharedRecordIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  }

  /** AND the trusted projectId, soft-delete, visibility and ABAC into one filter. */
  private scopedFilter(
    projectId: string,
    scope: VisibilityScope | undefined,
    extra: Record<string, unknown>[] = [],
    access?: AccessPredicate,
  ): Record<string, unknown> {
    const and: Record<string, unknown>[] = [{ projectId }, ...extra];
    // FIELD-ACT-departmentId (W-6): владение XOR — запись без assignee видна
    // членам подразделения-владельца (тот же контракт, что у contact).
    const vis = buildOwnableVisibilityFilter<ObjectId>(
      scope,
      OWNER_FIELD,
      DEPARTMENT_FIELD,
      this.sharedObjectIds(scope),
    );
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    return and.length === 1 ? and[0] : { $and: and };
  }

  private applyAccess(and: Record<string, unknown>[], access?: AccessPredicate): void {
    if (access?.present && access.malformed) {
      and.push({ _id: ActivityService.DENY_ALL_ID });
      return;
    }
    if (access?.present && !access.malformed && access.mongo && Object.keys(access.mongo).length) {
      and.push(access.mongo);
    }
  }

  private passesAccessGate(record: Record<string, unknown>, access?: AccessPredicate): boolean {
    if (!access || !access.present) return true;
    if (access.malformed) return false;
    if (!access.ir) return true;
    try {
      return evalGate(access.ir as AbacNode, record);
    } catch {
      return false;
    }
  }

  private validateStatus(status: string, allowTerminalOnCreate = false): string {
    if (!STATUSES.includes(status)) invalid('Unknown status', status);
    if (!allowTerminalOnCreate && TERMINAL.includes(status)) {
      invalid('Terminal status only via complete() or dedicated flow', status);
    }
    return status;
  }

  private validateDirection(direction: unknown, type: string): string {
    const d = String(direction ?? '');
    if (!d) return '';
    if (!DIRECTIONS.includes(d)) invalid('Unknown direction', d);
    if (type !== 'call') invalid('direction применим только к call', 'direction');
    return d;
  }

  private validatePriority(priority: unknown): string {
    const p = String(priority ?? 'medium');
    if (!PRIORITIES.includes(p)) invalid('Unknown priority', p);
    return p;
  }

  private resolveSort(sortField?: string, sortOrder?: string): Record<string, 1 | -1> {
    const key = sortField ? SORT_FIELDS[sortField] : undefined;
    const field = key ?? 'dueDate';
    const dir = sortOrder === 'desc' ? -1 : 1;
    return { [field]: dir };
  }

  private parseCreatedByRule(raw: unknown): { ruleId: string; name: string } | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const ruleId = String(o.rule_id ?? o.ruleId ?? '').trim();
    if (!ruleId) return null;
    const name = String(o.name ?? '').trim() || ruleId;
    return { ruleId, name };
  }

  private normalizeLinks(raw: unknown): Link[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((l) => {
        const o = l as {
          entity_type?: string;
          entity_id?: string;
          entityType?: string;
          entityId?: string;
        };
        return {
          entityType: String(o.entity_type ?? o.entityType ?? ''),
          entityId: String(o.entity_id ?? o.entityId ?? ''),
        };
      })
      .filter((l) => l.entityType || l.entityId)
      .map((l) => {
        if (!LINK_TYPES.includes(l.entityType))
          invalid('Unsupported link entityType', l.entityType);
        if (!l.entityId) invalid('link entityId required', 'links');
        // nameSnapshot/orphaned are filled in by NameResolverService (cross-domain gRPC
        // read, fail-soft) at create/update time; empty here is the pre-resolve default.
        return {
          entityType: l.entityType,
          entityId: l.entityId,
          nameSnapshot: '',
          orphaned: false,
        };
      });
  }

  private toRow(d: Record<string, unknown>) {
    const due = d.dueDate == null ? null : Number(d.dueDate);
    const status = String(d.status ?? 'planned');
    const overdue =
      due != null &&
      due > 0 &&
      due < Date.now() &&
      !TERMINAL.includes(status) &&
      d.deletedAt == null;
    const links = (Array.isArray(d.links) ? d.links : []) as Link[];
    // BFF bridge: first link of each type → flat *_id/*_name (deprecated, M6).
    const flat = (t: string) => links.find((l) => l.entityType === t);
    return {
      id: (d._id as ObjectId).toString(),
      type: String(d.type ?? 'task'),
      title: String(d.title ?? ''),
      description: String(d.description ?? ''),
      status,
      priority: String(d.priority ?? 'medium'),
      due_date: due ?? undefined,
      start_date: d.startDate == null ? undefined : Number(d.startDate),
      end_date: d.endDate == null ? undefined : Number(d.endDate),
      all_day: Boolean(d.allDay),
      assignee_id: String(d.assigneeId ?? ''),
      assignee_name: String(d.assigneeName ?? ''),
      department_id: String(d.departmentId ?? ''),
      created_by: String(d.createdBy ?? d.assigneeId ?? ''),
      deal_id: String(flat('deal')?.entityId ?? ''),
      deal_name: String(flat('deal')?.nameSnapshot ?? ''),
      contact_id: String(flat('contact')?.entityId ?? ''),
      contact_name: String(flat('contact')?.nameSnapshot ?? ''),
      company_id: String(flat('company')?.entityId ?? ''),
      company_name: String(flat('company')?.nameSnapshot ?? ''),
      order_id: String(flat('order')?.entityId ?? ''),
      order_name: String(flat('order')?.nameSnapshot ?? ''),
      links: links.map((l) => ({
        entity_type: l.entityType,
        entity_id: l.entityId,
        name_snapshot: l.nameSnapshot ?? '',
        orphaned: Boolean(l.orphaned),
      })),
      location: String(d.location ?? ''),
      direction: String(d.direction ?? ''),
      result: String(d.result ?? ''),
      duration: d.duration == null ? undefined : Number(d.duration),
      actual_duration: d.actualDuration == null ? undefined : Number(d.actualDuration),
      participants: Array.isArray(d.participants) ? (d.participants as string[]).map(String) : [],
      reminder_offset: String(d.reminderOffset ?? 'none'),
      reminder_fire_at: d.reminderFireAt == null ? undefined : Number(d.reminderFireAt),
      reminder_state: String(d.reminderState ?? 'none'),
      completed_at: d.completedAt == null ? undefined : Number(d.completedAt),
      deleted_at: d.deletedAt == null ? undefined : Number(d.deletedAt),
      overdue,
      created_at: Number(d.createdAt),
      updated_at: Number(d.updatedAt),
      ...(d.createdByRule && typeof d.createdByRule === 'object'
        ? {
            created_by_rule: {
              rule_id: String((d.createdByRule as Record<string, unknown>).ruleId ?? ''),
              name: String((d.createdByRule as Record<string, unknown>).name ?? ''),
            },
          }
        : {}),
    };
  }

  /**
   * TODO-170 / FR-CONTACTS-210: when contacts merge, activities whose `links[]`
   * still point at a tombstone source must be repointed at the survivor. Emits one
   * `crm.activity.updated` per moved row. Natural idempotency: a redelivery finds
   * nothing still on the source id.
   */
  async rewriteContactLinksOnMerge(
    projectId: string,
    sourceContactIds: string[],
    targetContactId: string,
    mergeIdempotencyKey: string,
  ): Promise<{ rewritten: number }> {
    const target = (targetContactId ?? '').trim();
    const sources = [...new Set(sourceContactIds.map((s) => s.trim()).filter(Boolean))].filter(
      (s) => s !== target,
    );
    if (!projectId || !target || sources.length === 0) return { rewritten: 0 };

    const now = Date.now();
    const rewritten = await this.outbox.withOutbox(async (session) => {
      let moved = 0;
      const intents: EmitIntent[] = [];
      for (const sourceId of sources) {
        const filter = {
          projectId,
          deletedAt: null,
          links: { $elemMatch: { entityType: 'contact', entityId: sourceId } },
        };
        const affected = (await this.mongo
          .activities()
          .find(filter, {
            projection: { _id: 1, type: 1, links: 1, assigneeId: 1, projectId: 1 },
            ...(session ? { session } : {}),
          })
          .toArray()) as Record<string, unknown>[];
        for (const doc of affected) {
          const rawLinks = (Array.isArray(doc.links) ? doc.links : []) as Link[];
          const nextLinks = rawLinks.map((l) =>
            l.entityType === 'contact' && l.entityId === sourceId
              ? { ...l, entityId: target, nameSnapshot: '', orphaned: false }
              : l,
          );
          const resolved = await this.nameResolver.resolveLinks(projectId, nextLinks);
          const oid = doc._id as ObjectId;
          await this.mongo
            .activities()
            .updateOne(
              { _id: oid, projectId },
              { $set: { links: resolved, updatedAt: now } },
              session ? { session } : {},
            );
          moved++;
          const base = this.eventBase({ ...doc, links: resolved });
          intents.push({
            type: 'crm.activity.updated',
            source: 'activity',
            projectId,
            subject: `activity/${base.activityId}`,
            idempotencyKey: `activity.contact_merged:${base.activityId}:${mergeIdempotencyKey}`,
            actorType: 'service',
            payload: { ...base, changedFields: ['links'] },
          });
        }
      }
      return { result: moved, intents };
    });
    return { rewritten };
  }

  /**
   * FR-COMPANIES-140: when companies merge, activities whose `links[]` still point
   * at a tombstone loser must be repointed at the surviving master. Emits one
   * `crm.activity.updated` per moved row. Natural idempotency: a redelivery finds
   * nothing still on the loser id.
   */
  async rewriteCompanyLinksOnMerge(
    projectId: string,
    loserId: string,
    masterId: string,
    mergeIdempotencyKey: string,
  ): Promise<{ rewritten: number }> {
    const loser = (loserId ?? '').trim();
    const master = (masterId ?? '').trim();
    if (!projectId || !loser || !master || loser === master) return { rewritten: 0 };

    const now = Date.now();
    const rewritten = await this.outbox.withOutbox(async (session) => {
      let moved = 0;
      const intents: EmitIntent[] = [];
      const filter = {
        projectId,
        deletedAt: null,
        links: { $elemMatch: { entityType: 'company', entityId: loser } },
      };
      const affected = (await this.mongo
        .activities()
        .find(filter, {
          projection: { _id: 1, type: 1, links: 1, assigneeId: 1, projectId: 1 },
          ...(session ? { session } : {}),
        })
        .toArray()) as Record<string, unknown>[];
      for (const doc of affected) {
        const rawLinks = (Array.isArray(doc.links) ? doc.links : []) as Link[];
        const nextLinks = rawLinks.map((l) =>
          l.entityType === 'company' && l.entityId === loser
            ? { ...l, entityId: master, nameSnapshot: '', orphaned: false }
            : l,
        );
        const resolved = await this.nameResolver.resolveLinks(projectId, nextLinks);
        const oid = doc._id as ObjectId;
        await this.mongo
          .activities()
          .updateOne(
            { _id: oid, projectId },
            { $set: { links: resolved, updatedAt: now } },
            session ? { session } : {},
          );
        moved++;
        const base = this.eventBase({ ...doc, links: resolved });
        intents.push({
          type: 'crm.activity.updated',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.company_merged:${base.activityId}:${mergeIdempotencyKey}`,
          actorType: 'service',
          payload: { ...base, changedFields: ['links'] },
        });
      }
      return { result: moved, intents };
    });
    return { rewritten };
  }

  /**
   * BX-OFFB-2: reassign EVERY live activity owned by a departing member (in one
   * project) to the new responsible — the service-triggered offboard cascade (no
   * scope; caller is control via the bus). Emits one `crm.activity.reassigned` per
   * activity so notification/denorm stay in sync — never a blunt `updateMany`
   * without events. Natural idempotency: a redelivery finds nothing still owned by
   * `fromUserId` → 0 reassigned. `offboardTs` keeps the per-record event
   * idempotency keys stable across an at-least-once redelivery.
   */
  async reassignOwnedRecords(
    projectId: string,
    fromUserId: string,
    toUserId: string,
    offboardTs: number,
  ): Promise<{ reassigned: number }> {
    const from = (fromUserId ?? '').trim();
    const to = (toUserId ?? '').trim();
    if (!projectId || !from || !to || from === to) return { reassigned: 0 };
    const filter = { projectId, assigneeId: from, deletedAt: null };
    const now = Date.now();
    let reassigned = 0;
    await this.outbox.withOutbox(async (session) => {
      // TOCTOU fix (MINOR-13): read the affected ids inside the SAME session/
      // transaction as the update, so a concurrent assigneeId change between the
      // read and the write can't desync the emitted per-record events from the
      // rows actually moved (phantom or missed `crm.activity.reassigned`).
      const affected = (await this.mongo
        .activities()
        .find(filter, {
          projection: { _id: 1, type: 1, links: 1, assigneeId: 1, projectId: 1 },
          ...(session ? { session } : {}),
        })
        .toArray()) as Record<string, unknown>[];
      if (!affected.length) return { result: undefined, intents: [] };
      const toName = await this.projectMembers.resolveMemberName(projectId, to);
      const res = await this.mongo
        .activities()
        .updateMany(
          filter,
          { $set: { assigneeId: to, assigneeName: toName, updatedAt: now } },
          session ? { session } : {},
        );
      reassigned = res.modifiedCount;
      const intents: EmitIntent[] = affected.map((doc) => {
        const base = this.eventBase(doc);
        return {
          type: 'crm.activity.reassigned',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.reassigned:${base.activityId}:${offboardTs}`,
          actorType: 'service',
          payload: { ...base, assigneeId: to, fromAssignee: from, toAssignee: to },
        };
      });
      return { result: undefined, intents };
    });
    return { reassigned };
  }

  /** FR-PROJ-215 */
  async countOwnedRecords(projectId: string, userId: string): Promise<number> {
    const uid = (userId ?? '').trim();
    if (!projectId || !uid) return 0;
    return this.mongo.activities().countDocuments({
      projectId,
      assigneeId: uid,
      deletedAt: null,
    });
  }

  async list(
    projectId: string,
    pageIndex: number,
    pageSize: number,
    opts: {
      query?: string;
      type?: string;
      types?: string[];
      status?: string;
      overdueOnly?: boolean;
      assigneeId?: string;
      departmentId?: string;
      linkEntityType?: string;
      linkEntityId?: string;
      dateFrom?: number;
      dateTo?: number;
      includeDeleted?: boolean;
      sortField?: string;
      sortOrder?: string;
      withoutAssignee?: boolean;
    } = {},
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    if (!projectId) invalid('projectId обязателен', 'projectId');
    const size = Math.min(Math.max(pageSize || 25, 1), 100);
    const extra: Record<string, unknown>[] = [
      { deletedAt: opts.includeDeleted ? { $ne: null } : null },
    ];
    if (opts.query?.trim()) extra.push({ title: new RegExp(escapeRegExp(opts.query.trim()), 'i') });
    const typeList = (opts.types?.length ? opts.types : opts.type ? [opts.type] : []).filter(
      Boolean,
    );
    for (const t of typeList) {
      if (!TYPES.includes(t)) invalid('Unknown type', t);
    }
    if (typeList.length === 1) extra.push({ type: typeList[0] });
    else if (typeList.length > 1) extra.push({ type: { $in: typeList } });
    if (opts.status) extra.push({ status: this.validateStatus(opts.status, true) });
    if (opts.assigneeId) extra.push({ assigneeId: opts.assigneeId });
    if (opts.withoutAssignee) {
      extra.push({
        $or: [{ assigneeId: null }, { assigneeId: '' }, { assigneeId: { $exists: false } }],
      });
    }
    if (opts.departmentId) extra.push({ departmentId: opts.departmentId });
    if (opts.linkEntityId) {
      const linkMatch: Record<string, string> = { entityId: opts.linkEntityId };
      if (opts.linkEntityType) linkMatch.entityType = opts.linkEntityType;
      extra.push({ links: { $elemMatch: linkMatch } });
    }
    if (opts.overdueOnly) {
      extra.push({ status: { $nin: TERMINAL }, dueDate: { $lt: Date.now() } });
    }
    if (opts.dateFrom != null || opts.dateTo != null) {
      const range: Record<string, number> = {};
      if (opts.dateFrom != null) range.$gte = opts.dateFrom;
      if (opts.dateTo != null) range.$lte = opts.dateTo;
      extra.push({ dueDate: range });
    }
    const filter = this.scopedFilter(projectId, scope, extra, access);
    const coll = this.mongo.activities();
    const total = await coll.countDocuments(filter);
    const rows = await coll
      .find(filter)
      .sort(this.resolveSort(opts.sortField, opts.sortOrder))
      .skip(Math.max(pageIndex, 0) * size)
      .limit(size)
      .toArray();
    return { list: rows.map((r) => this.toRow(r as Record<string, unknown>)), total };
  }

  /**
   * Список корзины (только удалённые, честный total для пагинации >100).
   * Trash — не альтернативный read-path: та же visibility/ABAC-обвязка, что и
   * обычный list, поэтому делегируем в list с includeDeleted=true (пользователь
   * видит в корзине только видимые записи). Фильтры активностей к корзине не
   * применяются — как в contact (project_id + пагинация + query).
   */
  async listTrash(
    projectId: string,
    pageIndex = 0,
    pageSize = 25,
    query?: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    return this.list(
      projectId,
      pageIndex,
      pageSize,
      { query, includeDeleted: true },
      scope,
      access,
    );
  }

  async countOverdue(
    projectId: string,
    assigneeId?: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    if (!projectId) invalid('projectId обязателен', 'projectId');
    const extra: Record<string, unknown>[] = [
      { deletedAt: null, status: { $nin: TERMINAL }, dueDate: { $lt: Date.now(), $gt: 0 } },
    ];
    if (assigneeId) extra.push({ assigneeId });
    const filter = this.scopedFilter(projectId, scope, extra, access);
    const count = await this.mongo.activities().countDocuments(filter);
    return { count };
  }

  async calendar(
    projectId: string,
    opts: {
      type?: string;
      mine?: string;
      linkEntityId?: string;
      dateFrom?: number;
      dateTo?: number;
    } = {},
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    if (!projectId) invalid('projectId обязателен', 'projectId');
    if (opts.dateFrom == null || opts.dateTo == null) {
      invalid('dateFrom и dateTo обязательны для календаря', 'dateFrom');
    }
    const extra: Record<string, unknown>[] = [{ deletedAt: null }];
    if (opts.type) {
      if (!TYPES.includes(opts.type)) invalid('Unknown type', opts.type);
      extra.push({ type: opts.type });
    }
    if (opts.mine === 'self' && scope?.selfId) extra.push({ assigneeId: scope.selfId });
    if (opts.linkEntityId) extra.push({ links: { $elemMatch: { entityId: opts.linkEntityId } } });
    const range: Record<string, number> = { $gte: opts.dateFrom, $lte: opts.dateTo };
    extra.push({
      $or: [
        { dueDate: range },
        { startDate: range },
        { startDate: { $lte: opts.dateTo }, endDate: { $gte: opts.dateFrom } },
      ],
    });
    const filter = this.scopedFilter(projectId, scope, extra, access);
    const rows = await this.mongo.activities().find(filter).limit(CALENDAR_MAX_ROWS).toArray();
    const now = Date.now();
    const colorByType: Record<string, string> = {
      task: '#6366f1',
      call: '#22c55e',
      meeting: '#0ea5e9',
      note: '#a3a3a3',
    };
    const events = rows
      .map((r) => {
        const d = r as Record<string, unknown>;
        const type = String(d.type ?? 'task');
        // note without a date never enters the calendar.
        const due = d.dueDate == null ? null : Number(d.dueDate);
        const start = d.startDate == null ? null : Number(d.startDate);
        const end = d.endDate == null ? null : Number(d.endDate);
        let evStart: number | null;
        let evEnd: number;
        let allDay: boolean;
        if (type === 'meeting' && start != null) {
          evStart = start;
          evEnd = end != null ? end : start + 3600000;
          allDay = Boolean(d.allDay);
        } else if (type === 'task' && due != null) {
          evStart = due;
          evEnd = due;
          allDay = true;
        } else if (due != null) {
          // call/other: a point at dueDate.
          evStart = due;
          evEnd = due;
          allDay = false;
        } else {
          evStart = null;
          evEnd = 0;
          allDay = false;
        }
        if (evStart == null) return null;
        const status = String(d.status ?? 'planned');
        const overdue = due != null && due < now && !TERMINAL.includes(status);
        return {
          id: (d._id as ObjectId).toString(),
          title: String(d.title ?? ''),
          start: evStart,
          end: evEnd,
          all_day: allDay,
          color: overdue ? '#ef4444' : (colorByType[type] ?? '#6366f1'),
          type,
          overdue,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e != null);
    return { events };
  }

  private async fetchVisible(
    projectId: string,
    id: string,
    scope: VisibilityScope | undefined,
    access?: AccessPredicate,
    opts: { includeDeleted?: boolean } = {},
  ) {
    if (!ObjectId.isValid(id)) notFound();
    const and: Record<string, unknown>[] = [{ _id: new ObjectId(id), projectId }];
    if (!opts.includeDeleted) and.push({ deletedAt: null });
    this.applyAccess(and, access);
    const filter = and.length === 1 ? and[0] : { $and: and };
    const d = await this.mongo.activities().findOne(filter);
    if (!d) notFound();
    const { assigneeId, departmentId } = d as { assigneeId?: string; departmentId?: string };
    if (
      !isOwnableRecordVisible(
        scope,
        assigneeId,
        departmentId,
        scope?.sharedRecordIds.includes(id) ?? false,
      )
    ) {
      notFound();
    }
    if (!this.passesAccessGate(d as Record<string, unknown>, access)) notFound();
    return d as Record<string, unknown>;
  }

  async get(projectId: string, id: string, scope?: VisibilityScope, access?: AccessPredicate) {
    if (!projectId) invalid('projectId обязателен', 'projectId');
    return this.toRow(await this.fetchVisible(projectId, id, scope, access));
  }

  /**
   * PEP: mutation of another user's record requires `activities:manage`.
   * Visibility ≠ right to mutate (V-12 / SEC-PEP-1). Owner short-circuits.
   */
  private assertCanMutate(
    doc: Record<string, unknown>,
    scope: VisibilityScope | undefined,
    canManage: boolean,
  ) {
    const owner = String(doc.assigneeId ?? '');
    const self = scope?.selfId ?? '';
    // No user context (s2s) → trust the service caller.
    if (!self) return;
    if (owner === self) return;
    if (!canManage) denied('Изменение чужой активности требует права manage');
  }

  private validateTypeProfile(
    type: string,
    fields: {
      title?: unknown;
      direction?: unknown;
      dueDate?: number | null;
      startDate?: number | null;
      endDate?: number | null;
      reminderOffset?: string;
      priority?: unknown;
      duration?: unknown;
      location?: unknown;
      participants?: unknown;
    },
    isCreate: boolean,
  ) {
    if (!TYPES.includes(type)) invalid('Unknown type', type);
    if (type === 'note') {
      if (fields.dueDate != null) invalid('note не может иметь срок', 'dueDate');
      if (fields.reminderOffset && fields.reminderOffset !== 'none')
        invalid('note не может иметь напоминание', 'reminderOffset');
    }
    if (type === 'call') {
      if (isCreate && !fields.direction) invalid('direction обязателен для call', 'direction');
    } else if (fields.direction) {
      invalid('direction применим только к call', 'direction');
    }
    if (type === 'meeting') {
      if (isCreate && (fields.startDate == null || fields.endDate == null))
        invalid('startDate/endDate обязательны для meeting', 'startDate');
    }
    if (fields.startDate != null && fields.endDate != null && fields.endDate < fields.startDate)
      invalid('endDate должен быть ≥ startDate', 'endDate');
    if (fields.reminderOffset && !REMINDER_OFFSETS.includes(fields.reminderOffset))
      invalid('Unknown reminderOffset', 'reminderOffset');

    // TZ §5.2 discriminated profiles — reject type-inapplicable fields (FR-ACTIVITIES-040).
    const reject = (field: string, message: string) => {
      if (this.fieldProvided(fields, field)) invalid(message, field);
    };
    if (type === 'task') {
      reject('direction', 'direction не применим к task');
      reject('duration', 'duration не применим к task');
      reject('location', 'location не применим к task');
      reject('participants', 'participants не применим к task');
    } else if (type === 'call') {
      reject('location', 'location не применим к call');
      reject('participants', 'participants не применим к call');
      reject('priority', 'priority не применим к call');
    } else if (type === 'meeting') {
      reject('direction', 'direction не применим к meeting');
      reject('priority', 'priority не применим к meeting');
    }
  }

  private fieldProvided(fields: Record<string, unknown>, key: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return false;
    const v = fields[key];
    if (v == null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'number') return Number.isFinite(v);
    return true;
  }

  /** Anchor timestamp for reminder: task/call → dueDate; meeting → startDate. */
  private reminderAnchor(
    type: string,
    due: number | null,
    startDate: number | null,
  ): number | null {
    if (type === 'note') return null;
    if (type === 'meeting') return startDate;
    return due;
  }

  /** Compute reminderFireAt/State from offset + type-specific anchor (FR-ACTIVITIES-070). */
  private reminder(
    offset: string | undefined,
    type: string,
    due: number | null,
    startDate: number | null,
  ) {
    if (!offset || offset === 'none') {
      return { reminderOffset: offset ?? 'none', reminderFireAt: null, reminderState: 'none' };
    }
    const anchor = this.reminderAnchor(type, due, startDate);
    if (anchor == null) {
      // BR-ACTIVITIES-160 / TZ V-9: offset without anchor is invalid, not silent none.
      invalid('reminderOffset требует дату срока или начала встречи', 'reminderOffset');
    }
    const fireAt = offset === 'at_time' ? anchor : anchor - reminderOffsetMs(offset);
    return { reminderOffset: offset, reminderFireAt: fireAt, reminderState: 'scheduled' };
  }

  async create(data: Record<string, unknown>, scope?: VisibilityScope) {
    const projectId = String(data.project_id ?? data.projectId ?? '');
    if (!projectId) invalid('projectId обязателен', 'projectId');
    const type = String(data.type ?? 'task');
    const assigneeId = String(data.assignee_id ?? '');
    if (!assigneeId) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'OWNER_REQUIRED: владелец активности не определён',
      });
    }
    // SEC-PEP-2: assignee must belong to the project (visibility escalation via
    // OWNER_FIELD='assigneeId'). Self-assign / empty short-circuit inside; control
    // unreachable → UNAVAILABLE (fail-closed).
    await this.projectMembers.assertAssigneeMember(projectId, assigneeId, scope?.selfId);
    // FIELD-ACT-departmentId (W-6): departmentId — ключ видимости, поэтому чужой /
    // несуществующий id прячет запись у всех, у кого режим не `all`. Пусто = не задано.
    const departmentId = String(data.department_id ?? '').trim();
    if (departmentId) await this.projectMembers.assertDepartmentValid(projectId, departmentId);

    const hasDue = data.has_due_date === true || data.due_date != null;
    let due: number | null = hasDue && data.due_date != null ? Number(data.due_date) : null;
    if (due == null && (type === 'task' || type === 'call') && !hasDue) {
      due = Date.now() + 86400000; // smart default
    }
    const startDate = data.start_date == null ? null : Number(data.start_date);
    const endDate = data.end_date == null ? null : Number(data.end_date);
    const reminderOffset = data.reminder_offset ? String(data.reminder_offset) : 'none';
    const title = data.title != null ? String(data.title) : '';
    const createdByRule = this.parseCreatedByRule(data.created_by_rule ?? data.createdByRule);
    const activityStatus = data.status ? this.validateStatus(String(data.status)) : 'planned';
    const priority = type === 'task' ? this.validatePriority(data.priority ?? 'medium') : 'medium';
    const direction = this.validateDirection(data.direction, type);
    if (type !== 'note' && !title.trim()) invalid('title обязателен', 'title');

    this.validateTypeProfile(
      type,
      {
        title,
        direction,
        dueDate: due,
        startDate,
        endDate,
        reminderOffset,
        priority: data.priority,
        duration: data.duration,
        location: data.location,
        participants: data.participants,
      },
      true,
    );

    const assigneeName = await this.projectMembers.resolveMemberName(projectId, assigneeId);

    // Bridge: flat *_id inputs map into links[] (deprecated path).
    let links = this.normalizeLinks(data.links);
    if (!links.length) {
      const flat: Array<[string, unknown]> = [
        ['deal', data.deal_id],
        ['contact', data.contact_id],
        ['company', data.company_id],
        ['order', data.order_id],
      ];
      links = flat
        .filter(([, v]) => v != null && String(v))
        .map(([t, v]) => ({
          entityType: t,
          entityId: String(v),
          nameSnapshot: '',
          orphaned: false,
        }));
    }
    // Resolve display-names cross-domain (fail-soft: donor down → empty snapshot,
    // never blocks creation; scoped to this projectId).
    links = await this.nameResolver.resolveLinks(projectId, links);

    const now = Date.now();
    const rem = this.reminder(reminderOffset, type, type === 'note' ? null : due, startDate);
    const doc: Record<string, unknown> = {
      _id: new ObjectId(),
      projectId,
      type,
      title,
      description: data.description != null ? String(data.description) : '',
      status: activityStatus,
      priority,
      dueDate: type === 'note' ? null : due,
      startDate,
      endDate,
      allDay: Boolean(data.all_day),
      direction,
      duration: data.duration == null ? null : Number(data.duration),
      actualDuration: null,
      location: data.location != null ? String(data.location) : '',
      participants: Array.isArray(data.participants)
        ? (data.participants as unknown[]).map(String)
        : [],
      result: '',
      assigneeId,
      assigneeName,
      departmentId,
      createdBy: assigneeId,
      links,
      reminderOffset: rem.reminderOffset,
      reminderFireAt: rem.reminderFireAt,
      reminderState: rem.reminderState,
      completedAt: null,
      deletedAt: null,
      overdueNotifiedAt: null,
      createdAt: now,
      updatedAt: now,
      ...(createdByRule ? { createdByRule } : {}),
    };
    // E3 transactional outbox: business write + event rows in one Mongo session.
    const saved = await this.outbox.withOutbox(async (session) => {
      await this.mongo.activities().insertOne(doc, session ? { session } : {});
      const row = await this.mongo
        .activities()
        .findOne({ _id: doc._id as ObjectId }, session ? { session } : {});
      const base = this.eventBase(doc);
      const userId = scope?.selfId || undefined;
      const intents: EmitIntent[] = [
        {
          type: 'crm.activity.created',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.created:${base.activityId}`,
          userId,
          actorType: userId ? 'user' : 'service',
          payload: {
            ...base,
            // TODO-051: flat denormalized title — the search projection reads
            // human-readable fields from the top level of the payload (FR-SEARCH-010).
            title: String(doc.title ?? ''),
            dueDate: doc.dueDate ?? null,
            createdBy: assigneeId,
            after: this.toRow(doc),
          },
        },
      ];
      // RFC-4 §5.1: reminder scheduled at create time → notify scheduler-consumer.
      if (rem.reminderState === 'scheduled') {
        intents.push({
          type: 'crm.activity.reminder_scheduled',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.reminder_scheduled:${base.activityId}:${reminderOffset}:${rem.reminderFireAt}`,
          userId,
          actorType: userId ? 'user' : 'service',
          payload: {
            ...base,
            fireAt: rem.reminderFireAt,
            recipientId: assigneeId,
            channel: 'in_app',
          },
        });
      }
      return { result: row, intents };
    });
    return this.toRow(saved as Record<string, unknown>);
  }

  async update(
    projectId: string,
    id: string,
    data: Record<string, unknown>,
    scope: VisibilityScope | undefined,
    canManage: boolean,
    access?: AccessPredicate,
  ) {
    if (!projectId) invalid('projectId обязателен', 'projectId');
    const doc = await this.fetchVisible(projectId, id, scope, access);
    this.assertCanMutate(doc, scope, canManage);

    const type = data.type != null ? String(data.type) : String(doc.type ?? 'task');
    const u: Record<string, unknown> = { updatedAt: Date.now() };
    const changed: string[] = [];

    const setIf = (key: string, value: unknown, field: string) => {
      if (value !== undefined) {
        u[key] = value;
        changed.push(field);
      }
    };

    if (data.title !== undefined) setIf('title', String(data.title), 'title');
    if (data.description !== undefined)
      setIf('description', String(data.description), 'description');
    if (data.priority !== undefined)
      setIf('priority', this.validatePriority(data.priority), 'priority');
    if (data.location !== undefined) setIf('location', String(data.location), 'location');
    if (data.direction !== undefined) {
      setIf('direction', this.validateDirection(data.direction, type), 'direction');
    }
    if (data.duration !== undefined)
      setIf('duration', data.duration == null ? null : Number(data.duration), 'duration');
    if (data.all_day !== undefined) setIf('allDay', Boolean(data.all_day), 'allDay');
    if (data.start_date !== undefined)
      setIf('startDate', data.start_date == null ? null : Number(data.start_date), 'startDate');
    if (data.end_date !== undefined)
      setIf('endDate', data.end_date == null ? null : Number(data.end_date), 'endDate');
    if (Array.isArray(data.participants))
      setIf('participants', (data.participants as unknown[]).map(String), 'participants');
    if (data.has_links === true) {
      // Re-resolve snapshots for the new link set (fail-soft, projectId-scoped).
      const resolvedLinks = await this.nameResolver.resolveLinks(
        projectId,
        this.normalizeLinks(data.links),
      );
      setIf('links', resolvedLinks, 'links');
    }

    // status transition guard (V-7): terminal → active is forbidden.
    if (data.status !== undefined) {
      const next = this.validateStatus(String(data.status), true);
      const cur = String(doc.status ?? 'planned');
      // Переход В completed — только через complete() (side-effects: completedAt,
      // result, событие). Эхо уже завершённого статуса (форма шлёт поле всегда) —
      // no-op, не ошибка.
      if (next === 'completed' && cur !== 'completed') {
        precondition('Завершение только через complete()');
      }
      if (TERMINAL.includes(cur) && !TERMINAL.includes(next)) {
        precondition(`Активность ${cur}: повторная активация запрещена`);
      }
      setIf('status', next, 'status');
    }

    // reassignment (A→B).
    let reassigned = false;
    if (data.assignee_id !== undefined) {
      const next = String(data.assignee_id);
      if (!next) invalid('OWNER_REQUIRED: владелец активности не определён', 'assigneeId');
      if (next !== String(doc.assigneeId ?? '')) {
        // SEC-PEP-2: reassign target must belong to the project. Self-assign / empty
        // short-circuit inside; control unreachable → UNAVAILABLE (fail-closed).
        await this.projectMembers.assertAssigneeMember(projectId, next, scope?.selfId);
        reassigned = true;
        const nextName = await this.projectMembers.resolveMemberName(projectId, next);
        setIf('assigneeName', nextName, 'assigneeName');
      }
      setIf('assigneeId', next, 'assigneeId');
    }

    // FIELD-ACT-departmentId (W-6): смена подразделения-владельца. Пустая строка —
    // законное снятие (proto3 optional отличает её от «поля не прислали»), поэтому
    // валидируем только непустое значение.
    if (data.department_id !== undefined) {
      const nextDepartment = String(data.department_id ?? '').trim();
      if (nextDepartment && nextDepartment !== String(doc.departmentId ?? '')) {
        await this.projectMembers.assertDepartmentValid(projectId, nextDepartment);
      }
      setIf('departmentId', nextDepartment, 'departmentId');
    }

    // reminder / due / meeting-start recompute.
    const dueChanged = data.due_date !== undefined;
    const remChanged = data.reminder_offset !== undefined;
    const startChanged = data.start_date !== undefined;
    let nextDue: number | null = doc.dueDate == null ? null : Number(doc.dueDate);
    if (dueChanged) {
      nextDue = data.due_date == null ? null : Number(data.due_date);
      setIf('dueDate', nextDue, 'dueDate');
    }
    let nextStart: number | null = doc.startDate == null ? null : Number(doc.startDate);
    if (startChanged) {
      nextStart = data.start_date == null ? null : Number(data.start_date);
    }
    const effType = type;
    const effOffset = remChanged
      ? String(data.reminder_offset)
      : String(doc.reminderOffset ?? 'none');
    const anchorChanged = dueChanged || remChanged || startChanged;
    if (anchorChanged) {
      const rem = this.reminder(effOffset, effType, effType === 'note' ? null : nextDue, nextStart);
      u.reminderOffset = rem.reminderOffset;
      u.reminderFireAt = rem.reminderFireAt;
      u.reminderState = rem.reminderState;
      if (remChanged) changed.push('reminderOffset');
    }

    // type-profile validation against the merged state + incoming forbidden fields.
    this.validateTypeProfile(
      effType,
      {
        title: u.title ?? doc.title,
        direction: u.direction ?? doc.direction,
        dueDate: effType === 'note' ? null : nextDue,
        startDate: (u.startDate ?? doc.startDate) as number | null,
        endDate: (u.endDate ?? doc.endDate) as number | null,
        reminderOffset: effOffset,
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
        ...(data.duration !== undefined ? { duration: data.duration } : {}),
        ...(data.location !== undefined ? { location: data.location } : {}),
        ...(data.participants !== undefined ? { participants: data.participants } : {}),
        ...(data.direction !== undefined ? { direction: data.direction } : {}),
      },
      false,
    );

    const oid = new ObjectId(id);
    const updatedAt = u.updatedAt as number;
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .activities()
        .updateOne({ _id: oid, projectId }, { $set: u }, session ? { session } : {});
      const base = this.eventBase(doc);
      const userId = scope?.selfId || undefined;
      const actorType: 'user' | 'service' = userId ? 'user' : 'service';
      const intents: EmitIntent[] = [
        {
          type: 'crm.activity.updated',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.updated:${base.activityId}:${updatedAt}`,
          userId,
          actorType,
          payload: {
            ...base,
            changedFields: changed,
            ...(changed.includes('dueDate') ? { dueDate: nextDue } : {}),
            // TODO-051: on rename ship the new flat title so the search projection
            // can refresh the indexed title (merge-семантика: absent ≠ blank).
            ...(u.title !== undefined ? { title: String(u.title) } : {}),
            // FIELD-ACT-departmentId (W-6): eventBase снят с ДО-состояния, поэтому
            // новое подразделение доезжает до подписчиков только явным полем.
            ...(u.departmentId !== undefined
              ? { departmentId: String(u.departmentId) || null }
              : {}),
          },
        },
      ];
      // RFC-4 §5.1: assignee A→B.
      if (reassigned) {
        intents.push({
          type: 'crm.activity.reassigned',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.reassigned:${base.activityId}:${String(u.assigneeId ?? '')}:${updatedAt}`,
          userId,
          actorType,
          payload: {
            ...base,
            assigneeId: String(u.assigneeId ?? base.assigneeId),
            fromAssignee: String(doc.assigneeId ?? ''),
            toAssignee: String(u.assigneeId ?? ''),
          },
        });
      }
      // RFC-4 §5.1: due/reminder/meeting-start change → cancel old, schedule new.
      if (anchorChanged) {
        const fireAt = u.reminderFireAt as number | null;
        const reminderKey = `activity.reminder:${base.activityId}`;
        intents.push({
          type: 'crm.activity.reminder_cancelled',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.reminder_cancelled:${base.activityId}:${reminderKey}`,
          userId,
          actorType,
          payload: { ...base, reminderKey },
        });
        if (u.reminderState === 'scheduled' && fireAt != null) {
          intents.push({
            type: 'crm.activity.reminder_scheduled',
            source: 'activity',
            projectId,
            subject: `activity/${base.activityId}`,
            idempotencyKey: `activity.reminder_scheduled:${base.activityId}:${effOffset}:${fireAt}`,
            userId,
            actorType,
            payload: {
              ...base,
              fireAt,
              recipientId: String(u.assigneeId ?? base.assigneeId),
              channel: 'in_app',
            },
          });
        }
      }
      return { result: undefined, intents };
    });
    return this.toRow(
      await this.fetchVisible(projectId, id, scope, access, { includeDeleted: true }),
    );
  }

  async complete(
    projectId: string,
    id: string,
    body: { result?: string; actualDuration?: number | null; completedAt?: number | null },
    scope: VisibilityScope | undefined,
    canManage: boolean,
    access?: AccessPredicate,
  ) {
    if (!projectId) invalid('projectId обязателен', 'projectId');
    const doc = await this.fetchVisible(projectId, id, scope, access);
    this.assertCanMutate(doc, scope, canManage);
    const cur = String(doc.status ?? 'planned');
    if (cur === 'completed') return this.toRow(doc); // idempotent no-op
    if (cur === 'cancelled') precondition('Активность отменена: завершение невозможно');
    const now = Date.now();
    const u: Record<string, unknown> = {
      status: 'completed',
      result: body.result != null ? String(body.result) : String(doc.result ?? ''),
      actualDuration:
        body.actualDuration == null ? (doc.actualDuration ?? null) : Number(body.actualDuration),
      completedAt: body.completedAt == null ? now : Number(body.completedAt),
      reminderState: 'cancelled',
      reminderFireAt: null,
      updatedAt: now,
    };
    const oid = new ObjectId(id);
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .activities()
        .updateOne({ _id: oid, projectId }, { $set: u }, session ? { session } : {});
      const base = this.eventBase(doc);
      const userId = scope?.selfId || undefined;
      const actorType: 'user' | 'service' = userId ? 'user' : 'service';
      const intents: EmitIntent[] = [
        {
          type: 'crm.activity.completed',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.completed:${base.activityId}`,
          userId,
          actorType,
          payload: {
            ...base,
            result: String(u.result ?? ''),
            completedAt: u.completedAt,
            actualDuration: u.actualDuration ?? null,
          },
        },
        {
          type: 'crm.activity.reminder_cancelled',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.reminder_cancelled:${base.activityId}:activity.reminder:${base.activityId}`,
          userId,
          actorType,
          payload: { ...base, reminderKey: `activity.reminder:${base.activityId}` },
        },
      ];
      return { result: undefined, intents };
    });
    return this.toRow(
      await this.fetchVisible(projectId, id, scope, access, { includeDeleted: true }),
    );
  }

  async remove(
    projectId: string,
    id: string,
    scope: VisibilityScope | undefined,
    canManage: boolean,
    access?: AccessPredicate,
  ) {
    if (!projectId) invalid('projectId обязателен', 'projectId');
    const doc = await this.fetchVisible(projectId, id, scope, access); // already-deleted → NOT_FOUND
    this.assertCanMutate(doc, scope, canManage);
    const now = Date.now();
    const oid = new ObjectId(id);
    await this.outbox.withOutbox(async (session) => {
      await this.mongo.activities().updateOne(
        { _id: oid, projectId },
        {
          $set: {
            deletedAt: now,
            reminderState: 'cancelled',
            reminderFireAt: null,
            updatedAt: now,
          },
        },
        session ? { session } : {},
      );
      const base = this.eventBase(doc);
      const userId = scope?.selfId || undefined;
      const actorType: 'user' | 'service' = userId ? 'user' : 'service';
      const intents: EmitIntent[] = [
        {
          type: 'crm.activity.deleted',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.deleted:${base.activityId}`,
          userId,
          actorType,
          payload: { ...base, before: this.toRow(doc) },
        },
        {
          type: 'crm.activity.reminder_cancelled',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.reminder_cancelled:${base.activityId}:activity.reminder:${base.activityId}`,
          userId,
          actorType,
          payload: { ...base, reminderKey: `activity.reminder:${base.activityId}` },
        },
      ];
      return { result: undefined, intents };
    });
    return {};
  }

  async restore(
    projectId: string,
    id: string,
    scope: VisibilityScope | undefined,
    canManage: boolean,
    access?: AccessPredicate,
  ) {
    if (!projectId) invalid('projectId обязателен', 'projectId');
    if (!ObjectId.isValid(id)) notFound();
    const doc = await this.mongo
      .activities()
      .findOne({ _id: new ObjectId(id), projectId, deletedAt: { $ne: null } });
    if (!doc) notFound();
    const record = doc as Record<string, unknown>;
    // Visibility gate on the trash record (anti-enumeration) + manage guard.
    if (
      !isOwnableRecordVisible(
        scope,
        String(record.assigneeId ?? ''),
        String(record.departmentId ?? ''),
        scope?.sharedRecordIds.includes(id) ?? false,
      )
    ) {
      notFound();
    }
    if (!this.passesAccessGate(record, access)) notFound();
    this.assertCanMutate(record, scope, canManage);
    const now = Date.now();
    const u: Record<string, unknown> = { deletedAt: null, updatedAt: now };
    // Reminder in the past → drop it.
    if (record.reminderFireAt != null && Number(record.reminderFireAt) < now) {
      u.reminderState = 'none';
      u.reminderFireAt = null;
    }
    // FR-ACTIVITIES-130: re-resolve link snapshots / orphaned flags after restore.
    const rawLinks = Array.isArray(record.links) ? (record.links as Link[]) : [];
    if (rawLinks.length > 0) {
      const resolved = await this.nameResolver.resolveLinks(projectId, rawLinks);
      // Transient resolve failure returns empty snapshot + orphaned:false — keep the
      // stored snapshot instead of wiping it (donor down must not degrade data).
      u.links = resolved.map((l, i) =>
        !l.orphaned && !l.nameSnapshot && rawLinks[i]?.nameSnapshot
          ? { ...l, nameSnapshot: rawLinks[i].nameSnapshot }
          : l,
      );
    }
    const oid = new ObjectId(id);
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .activities()
        .updateOne({ _id: oid, projectId }, { $set: u }, session ? { session } : {});
      // Restore has its own registered key (RFC-4 §Р-3, be-event-keys-rfc4): audit reads
      // the un-delete as a restore fact and search re-indexes the revived activity.
      const base = this.eventBase(record);
      const userId = scope?.selfId || undefined;
      const intents: EmitIntent[] = [
        {
          type: 'crm.activity.restored',
          source: 'activity',
          projectId,
          subject: `activity/${base.activityId}`,
          idempotencyKey: `activity.restored:${base.activityId}:${now}`,
          userId,
          actorType: userId ? 'user' : 'service',
          payload: { ...base, changedFields: ['deletedAt'] },
        },
      ];
      return { result: undefined, intents };
    });
    return this.toRow(
      await this.fetchVisible(projectId, id, scope, access, { includeDeleted: true }),
    );
  }

  /**
   * Atomically marks an overdue activity as notified (anti-duplicate for
   * `crm.activity.overdue`). Returns true only on the first successful claim.
   * Internal — for scheduler-consumer / overdue scanner (FR-ACTIVITIES-310).
   */
  async claimOverdueNotification(projectId: string, activityId: string): Promise<boolean> {
    if (!projectId || !activityId || !ObjectId.isValid(activityId)) return false;
    const now = Date.now();
    const doc = await this.mongo.activities().findOneAndUpdate(
      {
        _id: new ObjectId(activityId),
        projectId,
        deletedAt: null,
        status: { $nin: TERMINAL },
        dueDate: { $gt: 0, $lt: now },
        overdueNotifiedAt: null,
      },
      { $set: { overdueNotifiedAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    );
    return doc != null;
  }

  /**
   * FR-ACTIVITIES-310: find activities that became overdue but were not yet
   * escalated (`overdueNotifiedAt` is still null).
   */
  async findOverdueCandidates(limit = 100): Promise<Record<string, unknown>[]> {
    const now = Date.now();
    const cap = Math.max(1, Math.min(limit, 500));
    return (await this.mongo
      .activities()
      .find({
        deletedAt: null,
        status: { $nin: TERMINAL },
        dueDate: { $gt: 0, $lt: now },
        overdueNotifiedAt: null,
      })
      .limit(cap)
      .toArray()) as Record<string, unknown>[];
  }

  /**
   * FR-ACTIVITIES-310: claim + publish `crm.activity.overdue` for one row.
   * Returns true when the event was emitted (first claim only).
   */
  async publishOverdueEvent(doc: Record<string, unknown>): Promise<boolean> {
    const projectId = String(doc.projectId ?? '');
    const activityId = (doc._id as ObjectId).toString();
    if (!projectId || !activityId) return false;
    const claimed = await this.claimOverdueNotification(projectId, activityId);
    if (!claimed) return false;
    const base = this.eventBase(doc);
    try {
      await this.outbox.withOutbox(async (_session) => {
        const intents: EmitIntent[] = [
          {
            type: 'crm.activity.overdue',
            source: 'activity',
            projectId,
            subject: `activity/${activityId}`,
            idempotencyKey: `activity.overdue:${activityId}`,
            actorType: 'service',
            payload: {
              ...base,
              assigneeId: String(doc.assigneeId ?? ''),
            },
          },
        ];
        return { result: undefined, intents };
      });
    } catch (err) {
      // Claim is outside the outbox txn: if enqueue fails, release so the
      // scanner can retry instead of silently dropping the escalation.
      await this.releaseOverdueNotification(projectId, activityId);
      throw err;
    }
    return true;
  }

  /** Undo a claim after a failed outbox write so the next sweep can retry. */
  async releaseOverdueNotification(projectId: string, activityId: string): Promise<void> {
    if (!projectId || !activityId || !ObjectId.isValid(activityId)) return;
    await this.mongo
      .activities()
      .updateOne(
        { _id: new ObjectId(activityId), projectId, overdueNotifiedAt: { $ne: null } },
        { $set: { overdueNotifiedAt: null, updatedAt: Date.now() } },
      );
  }

  /**
   * Atomically marks a scheduled reminder as fired (anti-duplicate for delivery).
   * Internal — notification scheduler-consumer (TODO-116 / FR-ACTIVITIES-070).
   */
  async claimReminderFire(
    projectId: string,
    activityId: string,
    fireAt: number,
  ): Promise<Record<string, unknown> | null> {
    if (!projectId || !activityId || !ObjectId.isValid(activityId)) return null;
    if (!Number.isFinite(fireAt) || fireAt <= 0) return null;
    const now = Date.now();
    const doc = await this.mongo.activities().findOneAndUpdate(
      {
        _id: new ObjectId(activityId),
        projectId,
        deletedAt: null,
        status: { $nin: TERMINAL },
        reminderState: 'scheduled',
        reminderFireAt: fireAt,
      },
      { $set: { reminderState: 'fired', updatedAt: now } },
      { returnDocument: 'after' },
    );
    return doc ?? null;
  }

  /** s2s helper — returns proto-shaped row when claim succeeds. */
  async claimReminderFireWithRow(
    projectId: string,
    activityId: string,
    fireAt: number,
  ): Promise<{ claimed: boolean; activity?: Record<string, unknown> }> {
    const doc = await this.claimReminderFire(projectId, activityId, fireAt);
    if (!doc) return { claimed: false };
    return { claimed: true, activity: this.toRow(doc) };
  }

  /** Undo reminder fire claim after failed delivery so due-scanner can retry. */
  async releaseReminderFire(projectId: string, activityId: string, fireAt: number): Promise<void> {
    if (!projectId || !activityId || !ObjectId.isValid(activityId)) return;
    await this.mongo.activities().updateOne(
      {
        _id: new ObjectId(activityId),
        projectId,
        reminderState: 'fired',
        reminderFireAt: fireAt,
      },
      { $set: { reminderState: 'scheduled', updatedAt: Date.now() } },
    );
  }

  /**
   * FR-ACTIVITIES-250: refresh `links[].nameSnapshot` / `orphaned` when a linked
   * CRM entity changes or is removed. Does not emit bus events — link drift is a
   * denormalized projection only.
   */
  async syncLinksForEntity(
    projectId: string,
    entityType: string,
    entityId: string,
    mode: 'refresh' | 'orphan',
  ): Promise<{ updated: number }> {
    const type = (entityType ?? '').trim();
    const id = (entityId ?? '').trim();
    if (!projectId || !type || !id || !LINK_TYPES.includes(type)) return { updated: 0 };

    const filter = {
      projectId,
      deletedAt: null,
      links: { $elemMatch: { entityType: type, entityId: id } },
    };
    const affected = (await this.mongo
      .activities()
      .find(filter)
      .project({ _id: 1, links: 1 })
      .toArray()) as Record<string, unknown>[];
    if (!affected.length) return { updated: 0 };

    const now = Date.now();
    let updated = 0;
    for (const doc of affected) {
      const rawLinks = (Array.isArray(doc.links) ? doc.links : []) as Link[];
      let nextLinks: Link[];
      if (mode === 'orphan') {
        nextLinks = rawLinks.map((l) =>
          l.entityType === type && l.entityId === id
            ? { ...l, nameSnapshot: '', orphaned: true }
            : l,
        );
      } else {
        const resolved = await this.nameResolver.resolveLinks(projectId, rawLinks);
        nextLinks = resolved.map((l, i) =>
          !l.orphaned && !l.nameSnapshot && rawLinks[i]?.nameSnapshot
            ? { ...l, nameSnapshot: rawLinks[i].nameSnapshot ?? '' }
            : l,
        );
      }
      if (JSON.stringify(rawLinks) === JSON.stringify(nextLinks)) continue;
      await this.mongo
        .activities()
        .updateOne(
          { _id: doc._id as ObjectId, projectId },
          { $set: { links: nextLinks, updatedAt: now } },
        );
      updated++;
    }
    return { updated };
  }
}
