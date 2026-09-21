import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@fairflow/shared';
import { dedupKey, busQueueName, renderNotifyI18n } from '@fairflow/shared';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { NotificationService } from './notification.service';
import { ControlMembersService, type FanoutGroup } from '../control/control-members.service';
import { buildMatrixDeepLink } from './notification-deep-link';
import {
  activityDeepLink,
  activityNotificationBody,
  activityTitle,
  activityTypeLabel,
} from './notification-activity-context';
import { isBoxEdition } from './notification.catalog';
import { MetricsService } from '../metrics/metrics.service';
import {
  getAddresseeHandler,
  getEventSpec,
  matrixRoutingKeys,
  notifyTemplateVars,
} from './notification-consumer-handlers';
import { ScheduledReminderService } from './scheduled-reminder.service';
import { renderChatNotificationCopy } from './notification-chat-i18n';

type Channel = 'in_app' | 'email';

const CHAT_MESSAGE_CREATED_KEY = 'chat.message.created';
const ORG_DEACTIVATED_KEY = 'control.org.deactivated';
const REMINDER_SCHEDULED_KEY = 'crm.activity.reminder_scheduled';
const REMINDER_CANCELLED_KEY = 'crm.activity.reminder_cancelled';
const MEMBER_ACCESS_KEYS = new Set([
  'control.member.added',
  'control.member.changed',
  'control.member.removed',
]);
const PROJECT_ROLE_ACCESS_KEYS = new Set([
  'control.role.assigned',
  'control.role.revoked',
]);
const FANOUT_CHUNK_SIZE = parseInt(process.env.NOTIFICATION_FANOUT_CHUNK_SIZE ?? '50', 10);
/** NFR-ORG-050: pause between org-deactivation fan-out batches (ms). */
const ORG_DEACTIVATE_FANOUT_DELAY_MS = parseInt(
  process.env.NOTIFICATION_ORG_DEACTIVATE_FANOUT_DELAY_MS ?? '100',
  10,
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Materialization consumer (contract §3.10). Channels/severity/i18n from module
 * manifests (FR-NOTIF-210 / NFR-080); addressees verified via control (BR-NOTIF-025).
 * Activity events enrich payload/deep-link from notification-activity-context (FR-ACTIVITIES-290).
 *
 * Org-scoped `control.member.*` keys (FR-ORG-780) and `control.org.deactivated` are
 * handled outside the generic matrix because they carry no `projectId`.
 *
 * Fan-out: project-wide addressees (PA / leader / all-members, FR-MNOT-4/31) are
 * resolved via control `ProjectGrpc.ListMembers` (see `ControlMembersService`,
 * cached ~30 s, fail-soft) and UNIONed with the payload owner/assignee. Email
 * egress point-check (FR-NOTIF-330) runs in NotificationService.deliver().
 */
@Injectable()
export class NotificationConsumer implements OnModuleInit {
  private readonly logger = new Logger(NotificationConsumer.name);
  private readonly enabled = process.env.NOTIFICATION_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly rabbit: RabbitMqService,
    private readonly notifications: NotificationService,
    private readonly members: ControlMembersService,
    private readonly metrics: MetricsService,
    private readonly scheduledReminders: ScheduledReminderService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log(
        'notification materialization consumer disabled (NOTIFICATION_CONSUMER_ENABLED=false)',
      );
      return;
    }
    try {
      const keys = [
        ...matrixRoutingKeys(),
        CHAT_MESSAGE_CREATED_KEY,
        ORG_DEACTIVATED_KEY,
        REMINDER_SCHEDULED_KEY,
        REMINDER_CANCELLED_KEY,
        ...MEMBER_ACCESS_KEYS,
        ...PROJECT_ROLE_ACCESS_KEYS,
      ].filter((key) => !isBoxEdition() || !key.startsWith('billing.'));
      this.rabbit.consume(busQueueName('notifications.events'), keys, (payload, routingKey) =>
        this.materialize(payload, routingKey),
      );
      this.logger.log(`notification materialization consumer bound to ${keys.length} routing-keys`);
    } catch (err) {
      this.logger.error(`notification consumer failed to bind: ${String(err)}`);
    }
  }

  private async materialize(payload: Record<string, unknown>, routingKey: string): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const raw = env as unknown as Record<string, unknown>;
    const occurred = Number(raw.occurredAt ?? raw.occurred_at ?? 0);
    if (occurred > 0) this.metrics.setConsumerLagMs(Date.now() - occurred);

    try {
      if (routingKey === CHAT_MESSAGE_CREATED_KEY) {
        await this.materializeChatMessage(payload);
        this.metrics.recordEventConsumed('ok');
        return;
      }
      if (routingKey === ORG_DEACTIVATED_KEY) {
        await this.materializeOrgDeactivated(payload);
        this.metrics.recordEventConsumed('ok');
        return;
      }
      if (MEMBER_ACCESS_KEYS.has(routingKey)) {
        await this.materializeMemberAccessChange(payload, routingKey);
        this.metrics.recordEventConsumed('ok');
        return;
      }
      if (PROJECT_ROLE_ACCESS_KEYS.has(routingKey)) {
        await this.materializeProjectRoleAccessChange(payload, routingKey);
        this.metrics.recordEventConsumed('ok');
        return;
      }
      if (routingKey === REMINDER_SCHEDULED_KEY) {
        await this.materializeReminderScheduled(payload);
        this.metrics.recordEventConsumed('ok');
        return;
      }
      if (routingKey === REMINDER_CANCELLED_KEY) {
        await this.materializeReminderCancelled(payload);
        this.metrics.recordEventConsumed('ok');
        return;
      }

      const spec = getEventSpec(routingKey);
      const handler = getAddresseeHandler(routingKey);
      if (!spec || !handler) return;

      const projectId = str(env.projectId);
      if (!projectId) {
        this.logger.warn(`event ${routingKey} without projectId — skipped`);
        this.metrics.recordEventConsumed('ok');
        return;
      }

      const { modules, ok: modulesOk } = await this.members.getEffectiveModulesWithStatus(projectId);
      if (!modulesOk) {
        throw new Error(
          `control GetProject(${projectId}) unavailable — cannot verify effectiveModules for ${routingKey}`,
        );
      }
      if (!this.members.isModuleEnabled(modules, spec.moduleId)) {
        this.logger.debug(`event ${routingKey} skipped — module ${spec.moduleId} disabled in ${projectId}`);
        this.metrics.recordSuppressed('module_disabled');
        this.metrics.recordEventConsumed('ok');
        return;
      }

      const base = dedupKey(env);
      const payloadAddressees = handler.addressees(env).filter(Boolean);
      const fanoutGroups = (spec.fanout ?? handler.fanout ?? []) as FanoutGroup[];
      if (payloadAddressees.length === 0 && !fanoutGroups.length) {
        this.logger.debug(`event ${routingKey} ${base}: no resolvable addressee — skipped`);
        this.metrics.recordEventConsumed('ok');
        return;
      }

      const { members, ok: membersOk } = await this.members.getMembersWithStatus(projectId);
      if (!membersOk) {
        throw new Error(
          `control ListMembers(${projectId}) unavailable — cannot verify addressees for ${routingKey} ${base}`,
        );
      }
      const memberIds = new Set(members.map((m) => m.id));
      const verifiedPayload = payloadAddressees.filter((id) => memberIds.has(id));
      const fanoutAddressees = fanoutGroups.length
        ? await this.members.resolveFanout(projectId, fanoutGroups)
        : [];
      const recipients = Array.from(new Set([...verifiedPayload, ...fanoutAddressees]));
      if (recipients.length === 0) {
        this.logger.debug(`event ${routingKey} ${base}: no resolvable addressee — skipped`);
        this.metrics.recordEventConsumed('ok');
        return;
      }

      const subject = str(env.subject);
      const [entityType, entityId] = subject.includes('/') ? subject.split('/', 2) : ['', ''];
      const vars = notifyTemplateVars(env, entityType, entityId, handler);
      const rendered = spec.i18n
        ? renderNotifyI18n(spec.i18n, vars)
        : { title: routingKey, body: routingKey };
      const isActivity = routingKey.startsWith('crm.activity.');
      const title = rendered.title;
      const body = isActivity
        ? activityNotificationBody(env, rendered.body)
        : rendered.body;
      const deepLink = buildMatrixDeepLink(routingKey, env, entityType, entityId);
      const activityLink = isActivity
        ? activityDeepLink((env.payload ?? {}) as Record<string, unknown>)
        : undefined;
      const resolvedDeepLink = activityLink ?? deepLink;
      const dataJson = (() => {
        try {
          const baseData = (env.payload ?? {}) as Record<string, unknown>;
          const enriched = isActivity
            ? {
                ...baseData,
                title: activityTitle(baseData),
                type: activityTypeLabel(baseData.type),
                deepLink: resolvedDeepLink,
              }
            : baseData;
          return JSON.stringify(
            resolvedDeepLink ? { ...enriched, deepLink: resolvedDeepLink } : enriched,
          );
        } catch {
          return resolvedDeepLink ? JSON.stringify({ deepLink: resolvedDeepLink }) : '{}';
        }
      })();

      const chunks = chunk(recipients, FANOUT_CHUNK_SIZE);
      this.metrics.observeFanout(recipients.length, chunks.length);

      for (const batch of chunks) {
        for (const userId of batch) {
          const inserted = await this.notifications.materialize({
            project_id: projectId,
            user_id: userId,
            dedup_key: `${base}:${userId}`,
            category: spec.category,
            event_type: routingKey,
            severity: spec.severity,
            channels: spec.defaultChannels as Channel[],
            title,
            body,
            entity_type: entityType,
            entity_id: entityId,
            data_json: dataJson,
            source_message_id: str(env.messageId),
            collapse_window_sec: spec.collapseWindowSec ?? 0,
          });
          if (inserted) {
            this.logger.debug(`materialized ${routingKey} → user ${userId} (${projectId})`);
          }
        }
      }
      this.metrics.recordEventConsumed('ok');
    } catch (err) {
      this.metrics.recordEventConsumed('error');
      throw err;
    }
  }

  private async materializeChatMessage(payload: Record<string, unknown>): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = str(env.projectId);
    const p = (env.payload ?? {}) as Record<string, unknown>;
    const conversationId = str(p.conversationId);
    const messageId = str(p.messageId);
    const senderId = str(p.senderId);
    const seq = p.seq != null ? Number(p.seq) : undefined;
    const preview = str(p.preview);

    if (!conversationId || !messageId) {
      this.logger.warn('chat.message.created without conversationId/messageId — skipped');
      return;
    }

    const scope = (p.scope ?? {}) as Record<string, unknown>;
    const scopeKindRaw = str(scope.kind);
    const scopeProjectId = scopeKindRaw === 'project' ? str(scope.scopeId) : '';
    const projectIsolation = projectId || scopeProjectId;
    const isUserScoped = !projectIsolation && scopeKindRaw !== 'project' && scopeKindRaw !== '';

    if (!projectIsolation && !isUserScoped) {
      this.logger.warn('chat.message.created without project scope — skipped');
      return;
    }

    const scopeKind = isUserScoped ? 'user' : 'project';
    const storageProjectId = projectIsolation || str(scope.scopeId) || 'personal';

    if (!isUserScoped) {
      const { modules, ok } = await this.members.getEffectiveModulesWithStatus(projectIsolation);
      if (!ok) {
        throw new Error(`control GetProject(${projectIsolation}) unavailable — cannot verify chat module`);
      }
      if (!this.members.isModuleEnabled(modules, 'chat')) {
        this.metrics.recordSuppressed('module_disabled');
        return;
      }
    }

    const mentionIds = new Set(
      (Array.isArray(p.mentionIds) ? p.mentionIds : []).map(str).filter(Boolean),
    );
    const recipients = Array.from(
      new Set(
        (Array.isArray(p.recipientUserIds) ? p.recipientUserIds : []).map(str).filter(Boolean),
      ),
    ).filter((u) => u && u !== senderId);
    if (recipients.length === 0) return;

    let verified = recipients;
    if (!isUserScoped) {
      const { members, ok: membersOk } = await this.members.getMembersWithStatus(projectIsolation);
      if (!membersOk) {
        throw new Error(`control ListMembers(${projectIsolation}) unavailable — cannot verify chat addressees`);
      }
      const memberIds = new Set(members.map((m) => m.id));
      verified = recipients.filter((id) => memberIds.has(id));
      if (verified.length === 0) return;
    }

    const base = dedupKey(env);
    const deepLink = `/chat/${conversationId}${seq != null ? `?seq=${seq}` : ''}`;
    const conversationTitle = str(p.conversationTitle);
    const chunks = chunk(verified, FANOUT_CHUNK_SIZE);
    this.metrics.observeFanout(verified.length, chunks.length);

    for (const batch of chunks) {
      for (const userId of batch) {
        const isMention = mentionIds.has(userId);
        const eventMessageId = `${base}:${userId}`;
        const copy = renderChatNotificationCopy(isMention, preview);
        const inserted = await this.notifications.materializeChatNotification({
          project_id: storageProjectId,
          user_id: userId,
          scope_kind: scopeKind,
          event_message_id: eventMessageId,
          bus_message_id: messageId,
          conversation_id: conversationId,
          conversation_title: conversationTitle,
          seq,
          is_mention: isMention,
          event_type: CHAT_MESSAGE_CREATED_KEY,
          severity: isMention ? 'important' : 'info',
          channels: isMention ? ['in_app', 'email'] : ['in_app'],
          title: copy.title,
          body: copy.body,
          entity_type: 'conversation',
          entity_id: conversationId,
          data_payload: { ...p, isMention, deepLink, conversationId, messageId },
        });
        if (inserted) {
          this.logger.debug(`materialized chat msg → user ${userId} (${storageProjectId}, ${scopeKind})`);
        }
      }
    }
  }

  private async materializeOrgDeactivated(payload: Record<string, unknown>): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const p = (env.payload ?? {}) as Record<string, unknown>;
    const subject = str(env.subject);
    const [subjType, subjId] = subject.includes('/') ? subject.split('/', 2) : ['', ''];
    const orgId =
      str(p.organizationId) || str(p.entityId) || (subjType === 'organization' ? subjId : '');
    if (!orgId) {
      this.logger.warn('control.org.deactivated without organizationId — skipped');
      return;
    }
    const actorUserId = str(p.actorUserId) || str(env.userId);
    const recipients = await this.members.getOrgActiveMembers(orgId, actorUserId);
    if (recipients.length === 0) return;

    const base = dedupKey(env);
    const dataJson = (() => {
      try {
        return JSON.stringify(env.payload ?? {});
      } catch {
        return '{}';
      }
    })();

    const chunks = chunk(recipients, FANOUT_CHUNK_SIZE);
    this.metrics.observeFanout(recipients.length, chunks.length);

    for (const batch of chunks) {
      for (const userId of batch) {
        await this.notifications.materialize({
          project_id: orgId,
          user_id: userId,
          scope_kind: 'user',
          dedup_key: `${base}:${userId}`,
          category: 'org',
          event_type: ORG_DEACTIVATED_KEY,
          severity: 'important',
          channels: ['in_app', 'email'],
          title: 'Организация деактивирована',
          body: 'Ваша организация была деактивирована — доступ к её проектам приостановлен.',
          entity_type: 'organization',
          entity_id: orgId,
          data_json: dataJson,
          source_message_id: str(env.messageId),
        });
      }
      if (ORG_DEACTIVATE_FANOUT_DELAY_MS > 0) {
        await sleep(ORG_DEACTIVATE_FANOUT_DELAY_MS);
      }
    }
  }

  /**
   * FR-ORG-780: notify the subject of an org membership/access change when control
   * emits `control.member.added|changed|removed` (no `projectId` on the envelope).
   */
  private async materializeMemberAccessChange(
    payload: Record<string, unknown>,
    routingKey: string,
  ): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const p = (env.payload ?? {}) as Record<string, unknown>;
    const orgId = str(p.organizationId);
    const userId = str(p.entityId);
    if (!orgId || !userId) {
      this.logger.warn(`${routingKey} missing organizationId/entityId — skipped`);
      return;
    }
    const titles: Record<string, string> = {
      'control.member.added': 'Вас добавили в организацию',
      'control.member.changed': 'Изменились ваши права в организации',
      'control.member.removed': 'Вас исключили из организации',
    };
    const bodies: Record<string, string> = {
      'control.member.added': 'Вам открыт доступ к организации',
      'control.member.changed': 'Роль или доступ в организации были изменены',
      'control.member.removed': 'Доступ к организации был закрыт',
    };
    const base = dedupKey(env);
    const dataJson = (() => {
      try {
        return JSON.stringify(p);
      } catch {
        return '{}';
      }
    })();
    const inserted = await this.notifications.materialize({
      project_id: orgId,
      user_id: userId,
      scope_kind: 'user',
      dedup_key: `${base}:${userId}`,
      category: 'org',
      event_type: routingKey,
      severity: 'info',
      channels: ['in_app', 'email'],
      title: titles[routingKey] ?? 'Изменение доступа',
      body: bodies[routingKey] ?? 'Изменились параметры вашего доступа',
      entity_type: 'employee',
      entity_id: userId,
      data_json: dataJson,
    });
    if (inserted) {
      this.logger.debug(`materialized ${routingKey} → user ${userId} (${orgId})`);
    }
  }

  /**
   * FR-PROJ-280: notify project members when their role is assigned/changed/revoked.
   * Dedicated path (not the module-gated matrix) — subject may already be removed
   * from ListMembers on revoke, and the event must not depend on optional modules.
   */
  private async materializeProjectRoleAccessChange(
    payload: Record<string, unknown>,
    routingKey: string,
  ): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const p = (env.payload ?? {}) as Record<string, unknown>;
    const projectId = str(env.projectId);
    const userId = str(p.subjectUserId);
    if (!projectId || !userId) {
      this.logger.warn(`${routingKey} missing projectId/subjectUserId — skipped`);
      return;
    }
    const titles: Record<string, string> = {
      'control.role.assigned': 'Изменился ваш доступ к проекту',
      'control.role.revoked': 'Доступ к проекту закрыт',
    };
    const bodies: Record<string, string> = {
      'control.role.assigned': `Вам назначена роль «${str(p.role) || 'участник'}» в проекте`,
      'control.role.revoked': 'Вас исключили из проекта или отозвали доступ',
    };
    const base = dedupKey(env);
    const dataJson = (() => {
      try {
        return JSON.stringify(p);
      } catch {
        return '{}';
      }
    })();
    const inserted = await this.notifications.materialize({
      project_id: projectId,
      user_id: userId,
      scope_kind: 'user',
      dedup_key: `${base}:${userId}`,
      category: 'access',
      event_type: routingKey,
      severity: 'important',
      channels: ['in_app', 'email'],
      title: titles[routingKey] ?? 'Изменение доступа к проекту',
      body: bodies[routingKey] ?? 'Изменились параметры вашего доступа к проекту',
      entity_type: 'project_member',
      entity_id: userId,
      data_json: dataJson,
      source_message_id: str(env.messageId),
    });
    if (inserted) {
      this.logger.debug(`materialized ${routingKey} → user ${userId} (${projectId})`);
    }
  }

  /** TODO-116: persist delayed reminder row for due-scanner delivery. */
  private async materializeReminderScheduled(payload: Record<string, unknown>): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = str(env.projectId);
    if (!projectId) {
      this.logger.warn('crm.activity.reminder_scheduled without projectId — skipped');
      return;
    }
    const { modules, ok: modulesOk } = await this.members.getEffectiveModulesWithStatus(projectId);
    if (!modulesOk) {
      throw new Error(
        `control GetProject(${projectId}) unavailable — cannot schedule reminder`,
      );
    }
    if (!this.members.isModuleEnabled(modules, 'activities')) {
      this.metrics.recordSuppressed('module_disabled');
      return;
    }
    const stored = await this.scheduledReminders.upsertFromEvent(env);
    if (stored) {
      this.logger.debug(`scheduled reminder for project ${projectId}`);
    }
  }

  /** TODO-116: cancel pending delayed reminder rows. */
  private async materializeReminderCancelled(payload: Record<string, unknown>): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const p = (env.payload ?? {}) as Record<string, unknown>;
    const activityId = str(p.activityId ?? p.activity_id);
    const reminderKey = str(p.reminderKey) || (activityId ? `activity.reminder:${activityId}` : '');
    if (!reminderKey) {
      this.logger.warn('crm.activity.reminder_cancelled without reminderKey — skipped');
      return;
    }
    const cancelled = await this.scheduledReminders.cancelByReminderKey(reminderKey);
    if (cancelled > 0) {
      this.logger.debug(`cancelled ${cancelled} pending reminder(s) for ${reminderKey}`);
    }
  }
}
