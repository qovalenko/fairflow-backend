import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import {
  RequireModule,
  readVisibilityScope,
  readAccessPredicate,
  readUserId,
  readIdempotencyKey,
  resolveProjectId,
} from '@fairflow/shared';
import { ActivityService } from './activity.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

/**
 * Effective project id with defense-in-depth (IMPLEMENTATION-DEBT Д-5): trusted
 * x-project-id metadata wins over the body; a conflicting body projectId is
 * rejected. Metadata absent (s2s/internal) → body value (AS-IS fallback).
 */
function pid(d: { project_id?: string; projectId?: string }, metadata?: Metadata): string {
  return resolveProjectId(metadata, d.project_id ?? d.projectId);
}

function parseTypes(type?: string, types?: string[]): string[] | undefined {
  const fromRepeated = (types ?? []).map((t) => String(t).trim()).filter(Boolean);
  if (fromRepeated.length) return fromRepeated;
  const single = type?.trim();
  return single ? [single] : undefined;
}

@Controller()
@RequireModule('activities')
export class ActivityGrpcController {
  constructor(
    private readonly activity: ActivityService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @GrpcMethod('ActivityGrpc', 'ListActivities')
  list(
    d: {
      project_id?: string;
      projectId?: string;
      page_index?: number;
      page_size?: number;
      query?: string;
      type?: string;
      types?: string[];
      status?: string;
      overdue_only?: boolean;
      assignee_id?: string;
      department_id?: string;
      link_entity_type?: string;
      link_entity_id?: string;
      date_from?: number;
      date_to?: number;
      include_deleted?: boolean;
      sort_field?: string;
      sort_order?: string;
      without_assignee?: boolean;
    },
    metadata?: Metadata,
  ) {
    const types = parseTypes(d.type, d.types);
    return this.activity.list(
      pid(d, metadata),
      d.page_index ?? 0,
      d.page_size ?? 25,
      {
        query: d.query,
        type: types?.length === 1 ? types[0] : undefined,
        types: types && types.length > 1 ? types : undefined,
        status: d.status,
        overdueOnly: d.overdue_only,
        assigneeId: d.assignee_id,
        departmentId: d.department_id,
        linkEntityType: d.link_entity_type,
        linkEntityId: d.link_entity_id,
        dateFrom: d.date_from,
        dateTo: d.date_to,
        includeDeleted: d.include_deleted,
        sortField: d.sort_field,
        sortOrder: d.sort_order,
        withoutAssignee: Boolean(d.without_assignee),
      },
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('ActivityGrpc', 'ListTrash')
  listTrash(
    d: {
      project_id?: string;
      projectId?: string;
      page_index?: number;
      page_size?: number;
      query?: string;
    },
    metadata?: Metadata,
  ) {
    return this.activity.listTrash(
      pid(d, metadata),
      d.page_index ?? 0,
      d.page_size ?? 25,
      d.query,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('ActivityGrpc', 'CountOverdue')
  countOverdue(
    d: { project_id?: string; projectId?: string; assignee_id?: string },
    metadata?: Metadata,
  ) {
    return this.activity.countOverdue(
      pid(d, metadata),
      d.assignee_id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('ActivityGrpc', 'ListActivitiesCalendar')
  cal(
    d: {
      project_id?: string;
      projectId?: string;
      type?: string;
      mine?: string;
      link_entity_id?: string;
      date_from?: number;
      date_to?: number;
    },
    metadata?: Metadata,
  ) {
    return this.activity.calendar(
      pid(d, metadata),
      {
        type: d.type,
        mine: d.mine,
        linkEntityId: d.link_entity_id,
        dateFrom: d.date_from,
        dateTo: d.date_to,
      },
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('ActivityGrpc', 'GetActivity')
  get(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.activity.get(
      pid(d, metadata),
      d.id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('ActivityGrpc', 'CreateActivity')
  create(d: Record<string, unknown>, metadata?: Metadata) {
    const assigneeId = (d.assignee_id as string | undefined) || readUserId(metadata) || '';
    const projectId = resolveProjectId(
      metadata,
      (d.project_id ?? d.projectId) as string | undefined,
    );
    return this.idempotency.withIdempotency(
      projectId,
      readIdempotencyKey(metadata),
      'create',
      () =>
        this.activity.create(
          { ...d, project_id: projectId, projectId, assignee_id: assigneeId },
          readVisibilityScope(metadata),
        ),
      (result) => String((result as { id?: string }).id ?? ''),
    );
  }

  @GrpcMethod('ActivityGrpc', 'UpdateActivity')
  update(
    d: { project_id?: string; projectId?: string; id: string; can_manage?: boolean } & Record<
      string,
      unknown
    >,
    metadata?: Metadata,
  ) {
    return this.activity.update(
      pid(d, metadata),
      d.id,
      d,
      readVisibilityScope(metadata),
      d.can_manage === true,
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('ActivityGrpc', 'CompleteActivity')
  complete(
    d: {
      project_id?: string;
      projectId?: string;
      id: string;
      result?: string;
      actual_duration?: number;
      completed_at?: number;
      can_manage?: boolean;
    },
    metadata?: Metadata,
  ) {
    const projectId = pid(d, metadata);
    return this.idempotency.withIdempotency(
      projectId,
      readIdempotencyKey(metadata),
      'complete',
      () =>
        this.activity.complete(
          projectId,
          d.id,
          { result: d.result, actualDuration: d.actual_duration, completedAt: d.completed_at },
          readVisibilityScope(metadata),
          d.can_manage === true,
          readAccessPredicate(metadata),
        ),
      (result) => String((result as { id?: string }).id ?? d.id),
    );
  }

  @GrpcMethod('ActivityGrpc', 'DeleteActivity')
  remove(
    d: { project_id?: string; projectId?: string; id: string; can_manage?: boolean },
    metadata?: Metadata,
  ) {
    const projectId = pid(d, metadata);
    return this.idempotency.withIdempotency(
      projectId,
      readIdempotencyKey(metadata),
      'delete',
      () =>
        this.activity.remove(
          projectId,
          d.id,
          readVisibilityScope(metadata),
          d.can_manage === true,
          readAccessPredicate(metadata),
        ),
      () => d.id,
    );
  }

  @GrpcMethod('ActivityGrpc', 'RestoreActivity')
  restore(
    d: { project_id?: string; projectId?: string; id: string; can_manage?: boolean },
    metadata?: Metadata,
  ) {
    const projectId = pid(d, metadata);
    return this.idempotency.withIdempotency(
      projectId,
      readIdempotencyKey(metadata),
      'restore',
      () =>
        this.activity.restore(
          projectId,
          d.id,
          readVisibilityScope(metadata),
          d.can_manage === true,
          readAccessPredicate(metadata),
        ),
      (result) => String((result as { id?: string }).id ?? d.id),
    );
  }

  @GrpcMethod('ActivityGrpc', 'CountMemberOwnedRecords')
  async countMemberOwnedRecords(d: { project_id?: string; user_id?: string }, metadata?: Metadata) {
    const projectId = pid(d, metadata);
    const count = await this.activity.countOwnedRecords(projectId, d.user_id ?? '');
    return { count };
  }

  @GrpcMethod('ActivityGrpc', 'ReassignMemberOwnedRecords')
  async reassignMemberOwnedRecords(
    d: { project_id?: string; from_user_id?: string; to_user_id?: string },
    metadata?: Metadata,
  ) {
    const projectId = pid(d, metadata);
    const r = await this.activity.reassignOwnedRecords(
      projectId,
      d.from_user_id ?? '',
      d.to_user_id ?? '',
      Date.now(),
    );
    return { reassigned: r.reassigned };
  }

  @GrpcMethod('ActivityGrpc', 'ClaimReminderFire')
  async claimReminderFire(
    d: { project_id?: string; activity_id?: string; fire_at?: number },
    metadata?: Metadata,
  ) {
    const projectId = pid(d, metadata);
    const result = await this.activity.claimReminderFireWithRow(
      projectId,
      d.activity_id ?? '',
      Number(d.fire_at ?? 0),
    );
    return { claimed: result.claimed, activity: result.activity };
  }

  @GrpcMethod('ActivityGrpc', 'ReleaseReminderFire')
  async releaseReminderFire(
    d: { project_id?: string; activity_id?: string; fire_at?: number },
    metadata?: Metadata,
  ) {
    const projectId = pid(d, metadata);
    await this.activity.releaseReminderFire(projectId, d.activity_id ?? '', Number(d.fire_at ?? 0));
    return { released: true };
  }
}
