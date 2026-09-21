import { RequireModule, resolveProjectId } from '@fairflow/shared';
import type { Metadata } from '@grpc/grpc-js';
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { NotificationService, type CategoryPref } from './notification.service';

// Trusted x-project-id metadata wins over the body; a conflicting body projectId
// is rejected. Metadata absent (s2s/internal) → body value (AS-IS fallback).
function projectId(data: { project_id?: string; projectId?: string }, metadata?: Metadata): string {
  return resolveProjectId(metadata, data.project_id ?? data.projectId);
}

function userId(data: { user_id?: string; userId?: string }): string {
  return data.user_id ?? data.userId ?? '';
}

// SEC-N-5: per-user (project-less) handlers must resolve the addressee from the
// verified metadata x-user-id, never from request body. Falls back to the
// request user_id (BFF populates it from JWT) for transport robustness.
function userIdFromMeta(
  metadata: Metadata | undefined,
  data: { user_id?: string; userId?: string },
): string {
  const fromMeta = metadata?.get('x-user-id')?.[0];
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  return userId(data);
}

@Controller()
@RequireModule('notifications')
export class NotificationGrpcController {
  constructor(private readonly notifications: NotificationService) {}

  @GrpcMethod('NotificationGrpc', 'Send')
  send(
    data: {
      project_id?: string;
      projectId?: string;
      user_id?: string;
      userId?: string;
      channel?: string;
      title?: string;
      body?: string;
      data_json?: string;
      email_to?: string;
      category?: string;
      event_type?: string;
      eventType?: string;
      idempotency_key?: string;
      idempotencyKey?: string;
    },
    metadata?: Metadata,
  ) {
    return this.notifications.send({
      project_id: projectId(data, metadata),
      user_id: userId(data),
      channel: data.channel ?? 'in_app',
      title: data.title ?? '',
      body: data.body ?? '',
      data_json: data.data_json ?? '{}',
      email_to: data.email_to ?? '',
      category: data.category ?? '',
      event_type: data.event_type ?? data.eventType ?? '',
      idempotency_key: data.idempotency_key ?? data.idempotencyKey ?? '',
    });
  }

  @GrpcMethod('NotificationGrpc', 'ListNotifications')
  list(
    data: {
      project_id?: string;
      projectId?: string;
      user_id?: string;
      userId?: string;
      page_index?: number;
      page_size?: number;
      unread_only?: boolean;
      category?: string;
      scope?: string;
    },
    metadata?: Metadata,
  ) {
    return this.notifications.list(
      projectId(data, metadata),
      userId(data),
      data.page_index ?? 0,
      data.page_size ?? 25,
      data.unread_only ?? false,
      data.category || undefined,
      data.scope || undefined,
    );
  }

  @GrpcMethod('NotificationGrpc', 'MarkRead')
  markRead(
    data: {
      project_id?: string;
      projectId?: string;
      user_id?: string;
      userId?: string;
      notification_id?: string;
      notificationId?: string;
    },
    metadata?: Metadata,
  ) {
    return this.notifications.markRead(
      projectId(data, metadata),
      userId(data),
      data.notification_id ?? data.notificationId ?? '',
    );
  }

  @GrpcMethod('NotificationGrpc', 'MarkAllRead')
  markAllRead(
    data: {
      project_id?: string;
      projectId?: string;
      user_id?: string;
      userId?: string;
      scope?: string;
    },
    metadata?: Metadata,
  ) {
    return this.notifications.markAllRead(projectId(data, metadata), userId(data), data.scope);
  }

  @GrpcMethod('NotificationGrpc', 'GetCount')
  getCount(
    data: {
      project_id?: string;
      projectId?: string;
      user_id?: string;
      userId?: string;
      unread_only?: boolean;
      scope?: string;
    },
    metadata?: Metadata,
  ) {
    return this.notifications.getCount(
      projectId(data, metadata),
      userId(data),
      data.unread_only ?? true,
      data.scope || undefined,
    );
  }

  @GrpcMethod('NotificationGrpc', 'GetPreferences')
  getPreferences(data: { user_id?: string; userId?: string }, metadata?: Metadata) {
    return this.notifications.getPreferences(userIdFromMeta(metadata, data));
  }

  @GrpcMethod('NotificationGrpc', 'UpdatePreferences')
  updatePreferences(
    data: {
      user_id?: string;
      userId?: string;
      email_mode?: string;
      digest_time?: string;
      timezone?: string;
      categories?: CategoryPref[];
      quiet_hours?: { from: string; to: string; tz: string } | null;
    },
    metadata?: Metadata,
  ) {
    return this.notifications.updatePreferences({
      user_id: userIdFromMeta(metadata, data),
      email_mode: data.email_mode,
      digest_time: data.digest_time,
      timezone: data.timezone,
      categories: data.categories,
      quiet_hours: data.quiet_hours,
    });
  }

  @GrpcMethod('NotificationGrpc', 'GetCatalog')
  getCatalog(data: { project_id?: string; projectId?: string }, metadata?: Metadata) {
    return this.notifications.getCatalog(projectId(data, metadata));
  }
}
