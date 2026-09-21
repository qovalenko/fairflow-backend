import { status } from '@grpc/grpc-js';
import { newEntityId } from '@fairflow/shared';
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ObjectId } from 'mongodb';
import { MongoService } from '../mongo/mongo.service';
import { MailerService } from '../mail/mailer.service';
import { maskEmail, maskEmailsInText } from '../mail/pii-mask';
import { UserDirectoryService } from '../mail/user-directory.service';
import { NotificationSignalService } from '../realtime/notification-signal.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { emitNotificationEvent } from './event-emitter';
import { notificationExpiresAt } from './notification-retention';
import {
  renderNotificationEmail,
  renderTransactionalEmail,
  type TransactionalKind,
} from '../mail/email-templates';
import { catalogForEdition, filterCatalogByModules, type CategorySpec, isMandatory } from './notification.catalog';
import { ControlMembersService } from '../control/control-members.service';
import { resolveDeliveryChannels } from './notification-prefs';
import { buildCollapseKey } from './notification-collapse';
import { MetricsService } from '../metrics/metrics.service';
import { NotificationPointCheckService } from './notification-point-check.service';
import { isBoxEdition } from './notification.catalog';
import { resolveSendCategory } from './notification-send-category';

type NotificationDoc = {
  _id: ObjectId;
  id: string;
  project_id: string;
  user_id: string;
  channel: string;
  title: string;
  body: string;
  data_json: string;
  status: string;
  readed: boolean;
  email_to: string;
  created_at: number;
  sent_at: number;
  read_at: number;
  // TO-BE additive fields (contract §6.1)
  category?: string;
  event_type?: string;
  severity?: string;
  channels?: string[];
  entity_type?: string;
  entity_id?: string;
  email_status?: string;
  email_message_id?: string;
  email_error?: string;
  message_id?: string;
  /** High-frequency collapse grouping key (sparse index, FR-MNOT-19). */
  collapse_key?: string;
  /** Message ids already counted toward collapse (B-4 idempotency). */
  dedup_message_ids?: string[];
  /** TTL purge eligibility (FR-NOTIF-070). BSON Date, set at insert. */
  expires_at?: Date;
  /** `project` = visible only in matching project_id; `user` = cross-project personal feed. */
  scope_kind?: string;
};

/** Outcome of the email leg of a delivery (persisted as `email_status`). */
type EmailOutcome = {
  status: 'sent' | 'failed' | 'skipped' | 'none';
  to?: string;
  messageId?: string;
  error?: string;
};

type SendRequest = {
  project_id: string;
  user_id: string;
  channel: string;
  title: string;
  body: string;
  data_json: string;
  email_to: string;
  category?: string;
  event_type?: string;
  idempotency_key?: string;
};

export type CategoryPref = {
  category: string;
  in_app: boolean;
  email: boolean;
  escalate_offline?: boolean;
};

export type Preferences = {
  user_id: string;
  email_mode: string;
  digest_time: string;
  timezone: string;
  categories: CategoryPref[];
  quiet_hours: { from: string; to: string; tz: string } | null;
  updated_at: number;
};

export type UpdatePreferencesInput = {
  user_id: string;
  email_mode?: string;
  digest_time?: string;
  timezone?: string;
  categories?: CategoryPref[];
  quiet_hours?: { from: string; to: string; tz: string } | null;
};

type PrefsDoc = {
  _id: ObjectId;
  user_id: string;
  email_mode: string;
  digest_time: string;
  timezone: string;
  categories: CategoryPref[];
  quiet_hours: { from: string; to: string; tz: string } | null;
  updated_at: number;
};

const EMAIL_MODES = new Set(['immediate', 'hourly', 'daily', 'off']);
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Window for collapsing chat new_message notifications (FR-CHAT-315). */
export const CHAT_NOTIF_COLLAPSE_WINDOW_MS = parseInt(
  process.env.CHAT_NOTIF_COLLAPSE_WINDOW_MS ?? String(5 * 60 * 1000),
  10,
);

type Channel = 'in_app' | 'email';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly prefsCache = new Map<string, { prefs: Preferences; exp: number }>();
  private readonly prefsCacheTtlMs = parseInt(process.env.NOTIFICATION_PREFS_CACHE_TTL_MS ?? '30000', 10);
  private readonly prefsCacheMax = parseInt(process.env.NOTIFICATION_PREFS_CACHE_MAX ?? '1000', 10);

  constructor(
    private readonly mongo: MongoService,
    private readonly mailer: MailerService,
    private readonly directory: UserDirectoryService,
    private readonly signal: NotificationSignalService,
    private readonly rabbit: RabbitMqService,
    private readonly metrics: MetricsService,
    private readonly pointCheck: NotificationPointCheckService,
    private readonly controlMembers: ControlMembersService,
  ) {}

  private toMessage(doc: NotificationDoc) {
    return {
      id: doc.id,
      project_id: doc.project_id,
      user_id: doc.user_id,
      channel: doc.channel,
      title: doc.title,
      body: doc.body,
      data_json: doc.data_json,
      status: doc.status,
      readed: doc.readed,
      email_to: doc.email_to,
      created_at: doc.created_at,
      sent_at: doc.sent_at,
      read_at: doc.read_at,
      category: doc.category ?? '',
      event_type: doc.event_type ?? '',
      severity: doc.severity ?? 'info',
      channels: doc.channels ?? (doc.channel ? doc.channel.split('+') : []),
      entity_type: doc.entity_type ?? '',
      entity_id: doc.entity_id ?? '',
      email_status: doc.email_status ?? 'none',
    };
  }

  /** Fail-soft bus emit for audit/statistics consumers (RFC-4 E3). */
  private async emitAuditFact(
    type: string,
    payload: Record<string, unknown>,
    opts: {
      projectId?: string;
      userId?: string;
      subject?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<void> {
    try {
      await emitNotificationEvent(this.rabbit, {
        type,
        payload,
        projectId: opts.projectId,
        userId: opts.userId,
        subject: opts.subject,
        idempotencyKey: opts.idempotencyKey,
        actorType: opts.userId ? 'user' : 'service',
      });
    } catch (err) {
      this.logger.warn(
        `audit emit failed (${type}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private parseChannels(channelRaw: string): Channel[] {
    const norm = (channelRaw || '').toLowerCase().trim();
    if (!norm || norm === 'in_app' || norm === 'inapp' || norm === 'in-app') return ['in_app'];
    if (norm === 'email') return ['email'];
    if (norm === 'all' || norm === 'both' || norm === 'in_app+email') return ['in_app', 'email'];
    throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'Unsupported channel' });
  }

  /** Feed/badge queries: project-scoped rows + personal (DM/org) rows for the user. */
  private feedFilter(project_id: string, user_id: string): Record<string, unknown> {
    return {
      user_id,
      $or: [{ project_id, scope_kind: { $ne: 'user' } }, { scope_kind: 'user' }],
    };
  }

  /** Aggregated feed across all projects (FR-NOTIF-060 / scope=all). */
  private allProjectsFeedFilter(user_id: string): Record<string, unknown> {
    return { user_id };
  }

  private listFeedFilter(project_id: string, user_id: string, scope?: string): Record<string, unknown> {
    return scope === 'all'
      ? this.allProjectsFeedFilter(user_id)
      : this.feedFilter(project_id, user_id);
  }

  /**
   * Single-item mutation ownership (FR-NOTIF-030 / FR-NOTIF-060).
   * Isolated by addressee `user_id` (from verified JWT via gateway), not by the
   * current project: the aggregated `scope=all` feed shows rows from other
   * projects, and a project-scoped lookup made «прочитать» return NOT_FOUND.
   */
  private ownerFilter(
    _project_id: string,
    user_id: string,
    notification_id: string,
  ): Record<string, unknown> {
    return {
      id: notification_id,
      user_id,
    };
  }

  private async cachedPreferences(user_id: string): Promise<Preferences> {
    const now = Date.now();
    const hit = this.prefsCache.get(user_id);
    if (hit && hit.exp > now) return hit.prefs;
    const prefs = await this.getPreferences(user_id);
    // Bounded like the control-members cache (TODO-402): evict the oldest entry
    // instead of growing with every distinct fan-out addressee.
    if (this.prefsCache.size >= this.prefsCacheMax) {
      const oldest = this.prefsCache.keys().next().value;
      if (oldest) this.prefsCache.delete(oldest);
    }
    this.prefsCache.set(user_id, { prefs, exp: now + this.prefsCacheTtlMs });
    return prefs;
  }

  async resolveChannelsForUser(
    user_id: string,
    category: string,
    severity: string,
    requested: Channel[],
  ): Promise<Channel[]> {
    const prefs = await this.cachedPreferences(user_id);
    return resolveDeliveryChannels(prefs, category, severity, requested);
  }

  /**
   * Deliver to the requested channels. `in_app` is a read-model write already
   * persisted on insert (the feed/badge reads Mongo; SSE push is E3), so the only
   * active leg here is email. Email failures are captured, never thrown: the
   * in-app notification stays delivered and a consumer event is not re-queued to
   * the DLQ just because SMTP is down (at-least-once for the feed).
   */
  private async deliver(row: NotificationDoc, channels: Channel[]): Promise<EmailOutcome> {
    if (!channels.includes('email')) return { status: 'none' };
    const allowed = await this.pointCheck.canSendEmail(row);
    if (!allowed) {
      return { status: 'skipped', error: 'point_check_denied' };
    }
    return this.sendEmail(row);
  }

  private async sendEmail(row: NotificationDoc): Promise<EmailOutcome> {
    const prefs = await this.cachedPreferences(row.user_id);
    if (prefs.email_mode === 'off') {
      return { status: 'skipped', error: 'email_mode_off' };
    }
    if (prefs.email_mode !== 'immediate') {
      return { status: 'skipped', error: 'email_mode_deferred' };
    }
    if (!this.mailer.isEnabled()) return { status: 'skipped', error: 'mailer_disabled' };
    // SEC-N-9: resolve the recipient from the trusted user directory by user_id.
    // A body/event-supplied email_to is only a last-resort fallback.
    const resolved = await this.directory.resolveEmail(row.user_id);
    const to = (resolved || row.email_to || '').trim();
    if (!to) return { status: 'skipped', error: 'no_recipient' };

    const rendered = renderNotificationEmail({
      title: row.title,
      body: row.body,
      severity: (row.severity as 'info' | 'important' | 'critical') ?? 'info',
      ctaUrl: this.buildCtaUrl(row),
      preferencesUrl: this.preferencesUrl(),
    });
    try {
      const { messageId } = await this.mailer.sendMail({
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      void this.emitAuditFact(
        'notification.email.sent',
        {
          notification_id: row.id,
          event_type: row.event_type ?? '',
          category: row.category ?? '',
        },
        {
          projectId: row.project_id,
          userId: row.user_id,
          subject: `notification/${row.id}`,
          idempotencyKey: `notification.email.sent:${row.id}`,
        },
      );
      return { status: 'sent', to, messageId };
    } catch (err) {
      // X1: the mailbox is PII. The log gets the masked address and a transport
      // message scrubbed of any envelope address nodemailer echoed into it; `to`
      // itself stays intact in the RESULT because the addressee is a first-class
      // field of this domain's own document (`email_to`, used for resend), while
      // `error` is free-form text that also lands in order.lastError / the UI.
      this.logger.warn(
        `email to ${maskEmail(to)} failed (${row.event_type || 'direct'}): ${maskEmailsInText(err)}`,
      );
      return { status: 'failed', to, error: maskEmailsInText(err) };
    }
  }

  /** App deep-link CTA: APP_PUBLIC_URL + optional `deepLink` carried in data_json. */
  private buildCtaUrl(row: NotificationDoc): string | undefined {
    const base = (process.env.APP_PUBLIC_URL ?? '').replace(/\/+$/, '');
    if (!base) return undefined;
    let path = '';
    try {
      const data = JSON.parse(row.data_json || '{}') as Record<string, unknown>;
      if (typeof data.deepLink === 'string') path = data.deepLink;
    } catch {
      /* malformed data_json — fall back to the app root */
    }
    if (path && !path.startsWith('/')) path = `/${path}`;
    return base + path;
  }

  private preferencesUrl(): string | undefined {
    const base = (process.env.APP_PUBLIC_URL ?? '').replace(/\/+$/, '');
    return base ? `${base}/account/notifications` : undefined;
  }

  /** Persist the resolved email outcome onto the notification doc. */
  private emailUpdateFields(email: EmailOutcome): Record<string, unknown> {
    const set: Record<string, unknown> = { email_status: email.status };
    if (email.to) set.email_to = email.to;
    if (email.messageId) set.email_message_id = email.messageId;
    if (email.error) set.email_error = email.error;
    return set;
  }

  async send(data: SendRequest) {
    if (!data.project_id || !data.user_id) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'project_id and user_id are required',
      });
    }
    if (!data.title.trim() || !data.body.trim()) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'title and body are required',
      });
    }

    const idemKey = (data.idempotency_key ?? '').trim();
    // The dedup id is project-scoped: the {user_id, message_id} unique index is
    // global, so a raw client key reused in another project would return (or
    // collide with) the other project's row — a cross-project data return.
    const dedupId = idemKey ? `${data.project_id}:${idemKey}` : '';
    if (dedupId) {
      const dup = (await this.mongo
        .notifications()
        .findOne({ user_id: data.user_id, message_id: dedupId })) as unknown as NotificationDoc | null;
      if (dup) return this.toMessage(dup);
    }

    const { category, event_type: eventType } = resolveSendCategory(data);
    const requested = this.parseChannels(data.channel);
    const channels = await this.resolveChannelsForUser(
      data.user_id,
      category,
      'info',
      requested,
    );
    if (channels.length === 0) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'notification suppressed by user preferences',
      });
    }
    const now = Date.now();
    const id = newEntityId();
    const row: NotificationDoc = {
      _id: new ObjectId(),
      id,
      project_id: data.project_id,
      user_id: data.user_id,
      // Key-less sends fall back to the row id: the sparse {user_id, message_id}
      // index still indexes docs with a missing/null message_id, so a second
      // key-less send to the same user would otherwise hit E11000.
      message_id: dedupId || id,
      scope_kind: 'project',
      channel: channels.join('+'),
      channels,
      title: data.title.trim(),
      body: data.body.trim(),
      data_json: data.data_json || '{}',
      status: 'queued',
      readed: false,
      email_to: data.email_to || '',
      email_status: channels.includes('email') ? 'pending' : 'none',
      severity: 'info',
      category,
      event_type: eventType,
      created_at: now,
      expires_at: notificationExpiresAt(now),
      sent_at: 0,
      read_at: 0,
    };

    try {
      await this.mongo.notifications().insertOne(row);
    } catch (err) {
      // Second attempt of the same idempotency key racing the first insert:
      // the unique index rejects the copy — return the winner, don't 500.
      if (dedupId && (err as { code?: number }).code === 11000) {
        const dup = (await this.mongo
          .notifications()
          .findOne({ user_id: data.user_id, message_id: dedupId })) as unknown as NotificationDoc | null;
        if (dup) return this.toMessage(dup);
      }
      throw err;
    }
    const email = await this.deliver(row, channels);
    const sentAt = Date.now();
    await this.mongo
      .notifications()
      .updateOne(
        { _id: row._id },
        { $set: { status: 'sent', sent_at: sentAt, ...this.emailUpdateFields(email) } },
      );
    row.status = 'sent';
    row.sent_at = sentAt;
    row.email_status = email.status;
    if (email.to) row.email_to = email.to;
    // SSE badge: a new in-app item raised the user's unread count. Fail-soft.
    if (row.channels.includes('in_app')) {
      this.signal.publishBadge(row.user_id, row.project_id);
    }
    return this.toMessage(row);
  }

  async list(
    project_id: string,
    user_id: string,
    page_index: number,
    page_size: number,
    unread_only: boolean,
    category?: string,
    scope?: string,
  ) {
    const limit = Math.max(1, Math.min(page_size || 25, 200));
    const filter: Record<string, unknown> = {
      ...this.listFeedFilter(project_id, user_id, scope),
    };
    if (unread_only) filter.readed = false;
    if (category) filter.category = category;
    // suppressed notifications are never shown in the feed (BP-2 / contract §3.2).
    filter.status = { $ne: 'suppressed' };
    const total = await this.mongo.notifications().countDocuments(filter);
    const rows = (await this.mongo
      .notifications()
      .find(filter)
      .sort({ created_at: -1, _id: -1 })
      .skip(page_index * limit)
      .limit(limit)
      .toArray()) as unknown as NotificationDoc[];
    return {
      list: rows.map((row) => this.toMessage(row)),
      total,
    };
  }

  async markRead(project_id: string, user_id: string, notification_id: string) {
    const row = (await this.mongo
      .notifications()
      .findOne(this.ownerFilter(project_id, user_id, notification_id))) as unknown as NotificationDoc | null;
    if (!row) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Notification not found' });
    }
    // Idempotent: already-read returns the same result without re-writing (V-7, BP-7).
    if (row.readed && row.status === 'read') {
      return this.toMessage(row);
    }
    const now = Date.now();
    await this.mongo
      .notifications()
      .updateOne({ _id: row._id }, { $set: { readed: true, read_at: now, status: 'read' } });
    row.readed = true;
    row.read_at = now;
    row.status = 'read';
    // SSE badge: unread count dropped. Recompute so the client can update in-place
    // without a re-fetch; fail-soft (a bad read must not fail the mutation).
    const unread = await this.safeUnreadCount(project_id, user_id);
    this.signal.publishBadge(user_id, project_id, unread);
    void this.emitAuditFact(
      'notification.message.read',
      { notification_id, batch: false },
      {
        projectId: project_id,
        userId: user_id,
        subject: `notification/${notification_id}`,
        idempotencyKey: `notification.read:${project_id}:${user_id}:${notification_id}`,
      },
    );
    return this.toMessage(row);
  }

  async markAllRead(project_id: string, user_id: string, scope?: string) {
    const now = Date.now();
    const res = await this.mongo
      .notifications()
      .updateMany(
        {
          ...this.listFeedFilter(project_id, user_id, scope),
          readed: false,
          status: { $ne: 'suppressed' },
        },
        { $set: { readed: true, read_at: now, status: 'read' } },
      );
    // SSE badge reset: all read → unread is 0 by construction. Fail-soft.
    this.signal.publishBadge(user_id, project_id, 0);
    const updated = res.modifiedCount ?? 0;
    if (updated > 0) {
      void this.emitAuditFact(
        'notification.message.read',
        { batch: true, updated },
        {
          projectId: project_id,
          userId: user_id,
          subject: `project/${project_id}/notifications`,
        },
      );
    }
    return { updated, unread: 0 };
  }

  /** Unread badge count, never throwing — a realtime hint must not fail a mutation. */
  private async safeUnreadCount(project_id: string, user_id: string): Promise<number | undefined> {
    try {
      return await this.mongo
        .notifications()
        .countDocuments({
          ...this.feedFilter(project_id, user_id),
          readed: false,
          status: { $ne: 'suppressed' },
        });
    } catch {
      return undefined;
    }
  }

  async getCount(project_id: string, user_id: string, unread_only: boolean, scope?: string) {
    const filter: Record<string, unknown> = {
      ...this.listFeedFilter(project_id, user_id, scope),
    };
    if (unread_only) filter.readed = false;
    // suppressed not counted in the badge (BP-2).
    filter.status = { $ne: 'suppressed' };
    const count = await this.mongo.notifications().countDocuments(filter);
    return { count };
  }

  // ---- Preferences (per-user, project-less; SEC-N-5 addressee from metadata) ----

  private defaultPrefs(user_id: string): Preferences {
    return {
      user_id,
      email_mode: isBoxEdition() ? 'off' : 'immediate',
      digest_time: '',
      timezone: '',
      categories: [],
      quiet_hours: null,
      updated_at: 0,
    };
  }

  private prefsToResponse(doc: PrefsDoc): Preferences {
    return {
      user_id: doc.user_id,
      email_mode: doc.email_mode ?? 'immediate',
      digest_time: doc.digest_time ?? '',
      timezone: doc.timezone ?? '',
      categories: Array.isArray(doc.categories) ? doc.categories : [],
      quiet_hours: doc.quiet_hours ?? null,
      updated_at: doc.updated_at ?? 0,
    };
  }

  async getPreferences(user_id: string): Promise<Preferences> {
    if (!user_id) {
      throw new RpcException({ code: status.UNAUTHENTICATED, message: 'user_id is required' });
    }
    const doc = (await this.mongo.preferences().findOne({ user_id })) as unknown as PrefsDoc | null;
    if (!doc) return this.defaultPrefs(user_id);
    return this.prefsToResponse(doc);
  }

  async updatePreferences(input: UpdatePreferencesInput): Promise<Preferences> {
    if (!input.user_id) {
      throw new RpcException({ code: status.UNAUTHENTICATED, message: 'user_id is required' });
    }
    if (input.email_mode !== undefined && !EMAIL_MODES.has(input.email_mode)) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'Невалидное значение email_mode',
      });
    }
    if (
      input.digest_time !== undefined &&
      input.digest_time !== '' &&
      !HHMM_RE.test(input.digest_time)
    ) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'digest_time must be HH:mm',
      });
    }
    if (input.categories) {
      for (const c of input.categories) {
        // SEC-N-5 / V-5: mandatory/critical categories cannot be disabled.
        if (isMandatory(c.category) && (!c.in_app || !c.email)) {
          throw new RpcException({
            code: status.INVALID_ARGUMENT,
            message: 'Критичную категорию нельзя отключить',
          });
        }
      }
    }

    const now = Date.now();
    const set: Record<string, unknown> = { user_id: input.user_id, updated_at: now };
    if (input.email_mode !== undefined) set.email_mode = input.email_mode;
    if (input.digest_time !== undefined) set.digest_time = input.digest_time;
    if (input.timezone !== undefined) set.timezone = input.timezone;
    if (input.categories !== undefined) set.categories = input.categories;
    if (input.quiet_hours !== undefined) set.quiet_hours = input.quiet_hours;

    await this.mongo
      .preferences()
      .updateOne({ user_id: input.user_id }, { $set: set }, { upsert: true });
    this.prefsCache.delete(input.user_id);
    void this.emitAuditFact(
      'notification.preferences.changed',
      {
        user_id: input.user_id,
        email_mode: input.email_mode,
        digest_time: input.digest_time,
        timezone: input.timezone,
        categories: input.categories,
        quiet_hours: input.quiet_hours,
      },
      {
        userId: input.user_id,
        subject: `user/${input.user_id}/notification-preferences`,
        idempotencyKey: `notification.prefs:${input.user_id}:${now}`,
      },
    );
    const doc = (await this.mongo
      .preferences()
      .findOne({ user_id: input.user_id })) as unknown as PrefsDoc | null;
    return doc ? this.prefsToResponse(doc) : this.defaultPrefs(input.user_id);
  }

  // ---- Bus materialization (contract §3.10, consumer path) ----

  /**
   * Chat bus path (FR-CHAT-315): @mention → per-event notification; ordinary
   * new_message → window collapse «N новых в канале X» per conversation.
   */
  async materializeChatNotification(input: {
    project_id: string;
    user_id: string;
    event_message_id: string;
    bus_message_id: string;
    conversation_id: string;
    conversation_title?: string;
    seq?: number;
    is_mention: boolean;
    event_type: string;
    severity: string;
    channels: Channel[];
    title: string;
    body: string;
    entity_type: string;
    entity_id: string;
    data_payload: Record<string, unknown>;
    scope_kind?: string;
  }): Promise<boolean> {
    if (input.is_mention) {
      const dataJson = (() => {
        try {
          return JSON.stringify({ ...input.data_payload, isMention: true });
        } catch {
          return JSON.stringify({ conversationId: input.conversation_id, isMention: true });
        }
      })();
      return this.materialize({
        project_id: input.project_id,
        user_id: input.user_id,
        dedup_key: input.event_message_id,
        category: 'mention',
        event_type: input.event_type,
        severity: input.severity,
        channels: input.channels,
        title: input.title,
        body: input.body,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        data_json: dataJson,
        scope_kind: input.scope_kind,
      });
    }

    if (
      await this.chatBusEventAlreadyProcessed(
        input.user_id,
        input.event_message_id,
        input.bus_message_id,
        input.conversation_id,
      )
    ) {
      return false;
    }

    const now = Date.now();
    const bucket = Math.floor(now / CHAT_NOTIF_COLLAPSE_WINDOW_MS);
    const collapseMessageId = `chat:win:${input.conversation_id}:${input.user_id}:${bucket}`;
    const titleLabel = (input.conversation_title ?? '').trim() || 'беседе';
    const deepLink =
      input.seq != null ? `/chat/${input.conversation_id}?seq=${input.seq}` : undefined;

    const existing = (await this.mongo
      .notifications()
      .findOne({ user_id: input.user_id, message_id: collapseMessageId })) as unknown as
      | NotificationDoc
      | null;

    const channels = await this.resolveChannelsForUser(
      input.user_id,
      'new_message',
      'info',
      input.channels.length ? input.channels : (['in_app'] as Channel[]),
    );
    if (channels.length === 0) return false;

    if (existing) {
      return this.bumpCollapsedChatNotification({
        existing,
        input,
        titleLabel,
        deepLink,
        now,
        channels,
      });
    }

    const dataJson = JSON.stringify({
      ...input.data_payload,
      isMention: false,
      deepLink,
      counter: 1,
      dedup_message_ids: [input.bus_message_id],
      dedup_event_ids: [input.event_message_id],
    });
    const created = await this.materialize({
      project_id: input.project_id,
      user_id: input.user_id,
      dedup_key: collapseMessageId,
      category: 'new_message',
      event_type: input.event_type,
      severity: 'info',
      channels,
      title: 'Новые сообщения',
      body: `1 новое сообщение в «${titleLabel}»`,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      data_json: dataJson,
      scope_kind: input.scope_kind,
    });
    if (created) return true;

    // Lost the insert race: the window row already exists — fold this event in.
    const raced = (await this.mongo
      .notifications()
      .findOne({ user_id: input.user_id, message_id: collapseMessageId })) as unknown as
      | NotificationDoc
      | null;
    if (!raced) return false;
    return this.bumpCollapsedChatNotification({
      existing: raced,
      input,
      titleLabel,
      deepLink,
      now: Date.now(),
      channels,
    });
  }

  private async bumpCollapsedChatNotification(args: {
    existing: NotificationDoc;
    input: {
      project_id: string;
      user_id: string;
      event_message_id: string;
      bus_message_id: string;
      data_payload: Record<string, unknown>;
    };
    titleLabel: string;
    deepLink?: string;
    now: number;
    channels: Channel[];
  }): Promise<boolean> {
    const data = this.parseChatCollapseData(args.existing.data_json);
    const dedupMessageIds = new Set(data.dedup_message_ids ?? []);
    dedupMessageIds.add(args.input.bus_message_id);
    const dedupEventIds = new Set(data.dedup_event_ids ?? []);
    dedupEventIds.add(args.input.event_message_id);
    const counter = dedupMessageIds.size;
    const dataJson = JSON.stringify({
      ...args.input.data_payload,
      isMention: false,
      deepLink: args.deepLink ?? data.deepLink,
      counter,
      dedup_message_ids: [...dedupMessageIds],
      dedup_event_ids: [...dedupEventIds],
    });
    await this.mongo.notifications().updateOne(
      { _id: args.existing._id },
      {
        $set: {
          body: `${counter} новых сообщений в «${args.titleLabel}»`,
          data_json: dataJson,
          created_at: args.now,
          readed: false,
          expires_at: notificationExpiresAt(args.now),
          status: 'sent',
          sent_at: args.now,
        },
      },
    );
    if (args.channels.includes('in_app')) {
      this.signal.publishBadge(args.input.user_id, args.input.project_id);
    }
    return true;
  }

  private parseChatCollapseData(raw: string): {
    dedup_message_ids?: string[];
    dedup_event_ids?: string[];
    deepLink?: string;
  } {
    try {
      return JSON.parse(raw || '{}') as {
        dedup_message_ids?: string[];
        dedup_event_ids?: string[];
        deepLink?: string;
      };
    } catch {
      return {};
    }
  }

  private async chatBusEventAlreadyProcessed(
    userId: string,
    eventMessageId: string,
    busMessageId: string,
    conversationId: string,
  ): Promise<boolean> {
    const dupEvent = await this.mongo
      .notifications()
      .findOne({ user_id: userId, message_id: eventMessageId });
    if (dupEvent) return true;

    const windowStart = Date.now() - CHAT_NOTIF_COLLAPSE_WINDOW_MS;
    const recent = (await this.mongo
      .notifications()
      .find({
        user_id: userId,
        category: 'new_message',
        entity_type: 'conversation',
        ...(conversationId ? { entity_id: conversationId } : {}),
        created_at: { $gte: windowStart },
      })
      .limit(30)
      .toArray()) as unknown as NotificationDoc[];

    for (const doc of recent) {
      const data = this.parseChatCollapseData(doc.data_json);
      if (data.dedup_event_ids?.includes(eventMessageId)) return true;
      if (data.dedup_message_ids?.includes(busMessageId)) return true;
    }
    return false;
  }

  /**
   * Materialize a single resolved addressee notification from a bus event.
   * Idempotent on the dedup key (V-3, BP-8): the document carries
   * `message_id = dedupKey` and the Mongo uniq index `{user_id, message_id}`
   * collapses redeliveries / fan-in duplicates into a no-op. Returns true when a
   * new document was inserted, false on a deduped no-op.
   *
   * SEC-N-8: caller (consumer) is responsible for resolving addressees to only
   * the active members of `project_id`; this method does NOT widen the audience.
   */
  async materialize(input: {
    project_id: string;
    user_id: string;
    dedup_key: string;
    category: string;
    event_type: string;
    severity: string;
    channels: Channel[];
    title: string;
    body: string;
    entity_type?: string;
    entity_id?: string;
    data_json?: string;
    email_to?: string;
    scope_kind?: string;
    source_message_id?: string;
    collapse_window_sec?: number;
  }): Promise<boolean> {
    if (!input.project_id || !input.user_id || !input.dedup_key) return false;
    const requested = input.channels.length ? input.channels : (['in_app'] as Channel[]);
    const channels = await this.resolveChannelsForUser(
      input.user_id,
      input.category,
      input.severity,
      requested,
    );
    if (channels.length === 0) {
      this.metrics.recordSuppressed('preferences');
      return false;
    }

    const collapseWindow = input.collapse_window_sec ?? 0;
    const collapseKey =
      collapseWindow > 0
        ? buildCollapseKey({
            user_id: input.user_id,
            category: input.category,
            entity_type: input.entity_type,
            entity_id: input.entity_id,
            windowSec: collapseWindow,
          })
        : '';

    if (collapseKey) {
      const since = Date.now() - collapseWindow * 1000;
      const existing = (await this.mongo
        .notifications()
        .findOne({
          user_id: input.user_id,
          collapse_key: collapseKey,
          created_at: { $gte: since },
        })) as unknown as NotificationDoc | null;
      if (existing) {
        const seen = new Set(existing.dedup_message_ids ?? []);
        const src = (input.source_message_id ?? '').trim();
        if (src && seen.has(src)) return false;
        const count = (seen.size || 1) + (src ? 1 : 0);
        const nextIds = src ? [...seen, src] : [...seen];
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(existing.data_json || '{}') as Record<string, unknown>;
        } catch {
          /* keep empty */
        }
        data.collapse_count = count;
        const suffix = ` (${count} событий)`;
        const baseBody = input.body.replace(/\s*\(\d+ событий\)$/, '');
        await this.mongo.notifications().updateOne(
          { _id: existing._id },
          {
            $set: {
              body: `${baseBody}${suffix}`,
              data_json: JSON.stringify(data),
              dedup_message_ids: nextIds,
              readed: false,
              status: 'sent',
            },
          },
        );
        if (existing.channels?.includes('in_app')) {
          this.signal.publishBadge(existing.user_id, existing.project_id);
        }
        this.metrics.recordSuppressed('collapsed');
        return false;
      }
    }

    const now = Date.now();
    const src = (input.source_message_id ?? '').trim();
    const row: NotificationDoc = {
      _id: new ObjectId(),
      id: newEntityId(),
      project_id: input.project_id,
      user_id: input.user_id,
      message_id: input.dedup_key,
      collapse_key: collapseKey || undefined,
      dedup_message_ids: src ? [src] : [],
      scope_kind: input.scope_kind ?? 'project',
      channel: channels.join('+'),
      channels,
      category: input.category,
      event_type: input.event_type,
      severity: input.severity || 'info',
      entity_type: input.entity_type ?? '',
      entity_id: input.entity_id ?? '',
      title: input.title,
      body: input.body,
      data_json: input.data_json || '{}',
      status: 'queued',
      readed: false,
      email_to: input.email_to || '',
      email_status: channels.includes('email') ? 'pending' : 'none',
      created_at: now,
      expires_at: notificationExpiresAt(now),
      sent_at: 0,
      read_at: 0,
    };

    try {
      await this.mongo.notifications().insertOne(row);
    } catch (err) {
      // Duplicate key on {user_id, message_id} → already materialized, no-op ack
      // (idempotent redelivery, contract §3.10).
      if (this.isDuplicateKeyError(err)) return false;
      throw err;
    }

    this.metrics.recordCreated(row.category ?? '', row.severity ?? 'info');
    const email = await this.deliver(row, channels);
    const sentAt = Date.now();
    const emailDenied = channels.includes('email') && email.status === 'skipped' && email.error === 'point_check_denied';
    const finalStatus =
      emailDenied && !row.channels.includes('in_app') ? 'suppressed' : 'sent';
    await this.mongo
      .notifications()
      .updateOne(
        { _id: row._id },
        {
          $set: {
            status: finalStatus,
            sent_at: sentAt,
            ...this.emailUpdateFields(email),
            ...(emailDenied ? { channel: row.channels.filter((c) => c !== 'email').join('+') || 'in_app' } : {}),
          },
        },
      );
    if (email.status === 'sent') this.metrics.recordEmailSent(row.severity ?? 'info');
    if (email.status === 'failed') this.metrics.recordEmailFailed(row.severity ?? 'info');
    if (emailDenied) this.metrics.recordSuppressed('point_check');
    // SSE badge: a newly materialized in-app item raised the addressee's unread
    // count. `unread` is omitted (would cost an extra read per fan-out addressee);
    // the client re-fetches its count on the signal. Fail-soft.
    if (row.channels.includes('in_app')) {
      this.signal.publishBadge(row.user_id, row.project_id);
    }
    return true;
  }

  private isDuplicateKeyError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
  }

  // ---- Transactional email (project-less; auth flows) ----

  /**
   * Send a one-off transactional email (verify-email, password reset, email
   * change). Not written to the in-app feed — a pure email. The recipient `to`
   * is supplied by the trusted caller (auth via gateway), since the addressee may
   * not yet be a session user. Never throws: returns the outcome for the caller.
   */
  async sendTransactional(input: {
    to: string;
    kind: string;
    action_url: string;
    user_name?: string;
    subject?: string;
    title?: string;
    body?: string;
  }): Promise<EmailOutcome> {
    const to = (input.to || '').trim();
    if (!to) return { status: 'skipped', error: 'no_recipient' };
    if (!this.mailer.isEnabled()) {
      // X1: masked — this line is emitted on every send while MAIL_ENABLED is off,
      // i.e. it is the highest-volume place a client mailbox could reach the log.
      this.logger.warn(
        `transactional email (${input.kind}) to ${maskEmail(to)} skipped — mailer disabled`,
      );
      return { status: 'skipped', to, error: 'mailer_disabled' };
    }
    const rendered = renderTransactionalEmail({
      kind: (input.kind as TransactionalKind) || 'generic',
      actionUrl: input.action_url || '',
      userName: input.user_name,
      subject: input.subject || undefined,
      title: input.title || undefined,
      body: input.body || undefined,
    });
    try {
      const { messageId } = await this.mailer.sendMail({
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      return { status: 'sent', to, messageId };
    } catch (err) {
      // X1: `error` is the string automation copies verbatim into `order.lastError`
      // (persistent, operator-visible order state). Mask the addresses INSIDE it —
      // do not drop the text: the SMTP code/wording is what makes the failure
      // diagnosable ("550 … Recipient address rejected" vs "connection timeout").
      this.logger.warn(
        `transactional email (${input.kind}) to ${maskEmail(to)} failed: ${maskEmailsInText(err)}`,
      );
      return { status: 'failed', to, error: maskEmailsInText(err) };
    }
  }

  // ---- Catalog (project-scope; computed) ----

  async getCatalog(project_id: string): Promise<{ categories: CategorySpec[] }> {
    const base = catalogForEdition();
    const pid = (project_id ?? '').trim();
    if (!pid) return { categories: base };

    const { modules, ok } = await this.controlMembers.getEffectiveModulesWithStatus(pid);
    if (!ok) {
      throw new RpcException({
        code: status.UNAVAILABLE,
        message: `control GetProject(${pid}) unavailable — cannot filter notification catalog`,
      });
    }
    return { categories: filterCatalogByModules(base, modules) };
  }
}
