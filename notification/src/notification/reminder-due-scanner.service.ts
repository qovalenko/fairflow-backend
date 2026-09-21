import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@fairflow/shared';
import { getNotificationEventSpec, renderNotifyI18n } from '@fairflow/shared';
import { ActivityClaimService } from '../activity/activity-claim.service';
import { ControlMembersService } from '../control/control-members.service';
import { MetricsService } from '../metrics/metrics.service';
import { NotificationService } from './notification.service';
import {
  activityDeepLink,
  activityNotificationBody,
  activityTitle,
  activityTypeLabel,
} from './notification-activity-context';
import { ScheduledReminderService } from './scheduled-reminder.service';

const REMINDER_EVENT = 'crm.activity.reminder';

/**
 * TODO-116 / NFR-ACT-050: notification-owned due-scan (60s) that delivers
 * scheduled activity reminders at `fireAt` without RabbitMQ delayed-plugin.
 */
@Injectable()
export class ReminderDueScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReminderDueScannerService.name);
  private timer: NodeJS.Timeout | null = null;

  private readonly enabled = (process.env.NOTIFICATION_REMINDER_SCANNER_ENABLED ?? 'true') !== 'false';
  private readonly intervalMs = Number(process.env.NOTIFICATION_REMINDER_SCAN_INTERVAL_MS ?? 60_000);
  private readonly batchSize = Number(process.env.NOTIFICATION_REMINDER_SCAN_BATCH ?? 100);

  constructor(
    private readonly scheduled: ScheduledReminderService,
    private readonly activityClaim: ActivityClaimService,
    private readonly notifications: NotificationService,
    private readonly members: ControlMembersService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('reminder due-scanner disabled (NOTIFICATION_REMINDER_SCANNER_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref?.();
    this.logger.log(
      `reminder due-scanner started (every ${this.intervalMs}ms, batch ${this.batchSize})`,
    );
    void this.sweep();
  }

  async sweep(): Promise<{ delivered: number }> {
    let delivered = 0;
    try {
      const candidates = await this.scheduled.findDueCandidates(this.batchSize);
      for (const row of candidates) {
        if (await this.deliverOne(row)) delivered++;
      }
      if (delivered > 0) {
        this.logger.log(`reminder due-scanner delivered ${delivered} reminder(s)`);
      }
    } catch (err) {
      this.logger.warn(`reminder due-scanner sweep failed: ${String(err)}`);
    }
    return { delivered };
  }

  private async deliverOne(row: {
    _id: import('mongodb').ObjectId;
    project_id: string;
    activity_id: string;
    recipient_id: string;
    fire_at: number;
    payload_json: string;
  }): Promise<boolean> {
    const claimed = await this.scheduled.claimDue(row._id);
    if (!claimed) return false;

    const { modules, ok: modulesOk } = await this.members.getEffectiveModulesWithStatus(
      claimed.project_id,
    );
    if (!modulesOk) {
      await this.scheduled.releaseClaim(row._id);
      throw new Error(`control GetProject(${claimed.project_id}) unavailable for reminder delivery`);
    }
    if (!this.members.isModuleEnabled(modules, 'activities')) {
      await this.scheduled.markCancelled(row._id);
      this.metrics.recordSuppressed('module_disabled');
      return false;
    }

    const { members, ok: membersOk } = await this.members.getMembersWithStatus(
      claimed.project_id,
    );
    if (!membersOk) {
      await this.scheduled.releaseClaim(row._id);
      throw new Error(
        `control ListMembers(${claimed.project_id}) unavailable for reminder delivery`,
      );
    }
    if (!members.some((m) => m.id === claimed.recipient_id)) {
      await this.scheduled.markCancelled(row._id);
      this.metrics.recordSuppressed('not_a_member');
      return false;
    }

    let claim: { claimed: boolean };
    try {
      claim = await this.activityClaim.claimReminderFire(
        claimed.project_id,
        claimed.activity_id,
        claimed.fire_at,
      );
    } catch (err) {
      await this.scheduled.releaseClaim(row._id);
      throw err;
    }
    if (!claim.claimed) {
      await this.scheduled.markCancelled(row._id);
      return false;
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(claimed.payload_json || '{}') as Record<string, unknown>;
    } catch {
      payload = {};
    }

    const spec = getNotificationEventSpec(REMINDER_EVENT);
    if (!spec) {
      await this.scheduled.releaseClaim(row._id);
      return false;
    }

    const env = {
      projectId: claimed.project_id,
      subject: `activity/${claimed.activity_id}`,
      payload,
    } as EventEnvelope<Record<string, unknown>>;
    const rendered = spec.i18n
      ? renderNotifyI18n(spec.i18n, {
          entityLabel: activityTitle(payload),
          entityType: 'activity',
          entityId: claimed.activity_id,
          projectId: claimed.project_id,
          metric: '',
          dealId: '',
          orderId: '',
          contactId: '',
          companyId: '',
          role: '',
          from: '',
          to: '',
          expiresAt: '',
        })
      : { title: REMINDER_EVENT, body: REMINDER_EVENT };
    const title = rendered.title;
    const body = activityNotificationBody(env, rendered.body);
    const deepLink = activityDeepLink(payload);
    const dataJson = JSON.stringify({
      ...payload,
      title: activityTitle(payload),
      type: activityTypeLabel(payload.type),
      ...(deepLink ? { deepLink } : {}),
    });

    try {
      const inserted = await this.notifications.materialize({
        project_id: claimed.project_id,
        user_id: claimed.recipient_id,
        dedup_key: `activity.reminder:${claimed.activity_id}:${claimed.fire_at}`,
        category: spec.category,
        event_type: REMINDER_EVENT,
        severity: spec.severity,
        channels: spec.defaultChannels as ('in_app' | 'email')[],
        title,
        body,
        entity_type: 'activity',
        entity_id: claimed.activity_id,
        data_json: dataJson,
      });
      if (inserted) {
        this.metrics.observeReminderDeliveryLag(Date.now() - claimed.fire_at);
      }
      return inserted;
    } catch (err) {
      await this.activityClaim.releaseReminderFire(
        claimed.project_id,
        claimed.activity_id,
        claimed.fire_at,
      );
      await this.scheduled.releaseClaim(row._id);
      throw err;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
