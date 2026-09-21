import { Injectable } from '@nestjs/common';
import { EVENT_VERSION, newEntityId, type EventEnvelope } from '@fairflow/shared';
import { RequestContext } from '../common/request-context';
import { AuthBusPublisherService } from './auth-bus-publisher.service';

type GatewayProfileEvent =
  | 'gateway.profile.updated'
  | 'gateway.profile.avatar_updated'
  | 'gateway.profile.email_change_requested'
  | 'gateway.profile.email_changed'
  | 'gateway.profile.session_revoked';

type GatewayAuthEvent = 'gateway.auth.password_changed' | 'gateway.auth.mfa_changed';

/**
 * Security-fact events from the auth domain. Registered `gateway.auth.*` /
 * `gateway.profile.*` keys are published on the bus. Payloads carry field names /
 * metadata, never PII values (BR-MPROF-30).
 */
@Injectable()
export class ProfileEventsService {
  constructor(private readonly bus: AuthBusPublisherService) {}

  private build<T>(type: string, userId: string, payload: T): EventEnvelope<T> {
    return {
      type,
      version: EVENT_VERSION,
      messageId: newEntityId(),
      idempotencyKey: `${type}:${userId}:${newEntityId()}`,
      timestamp: new Date().toISOString(),
      source: 'auth',
      traceId: RequestContext.getTraceId(),
      userId,
      actorType: 'user',
      subject: `user/${userId}`,
      payload,
    };
  }

  private publish(
    type: GatewayProfileEvent | GatewayAuthEvent,
    userId: string,
    payload: Record<string, unknown>,
  ): void {
    void this.bus.publish({
      type,
      source: 'auth',
      userId,
      actorType: 'user',
      subject: `user/${userId}`,
      idempotencyKey: `${type}:${userId}:${Date.now()}`,
      payload,
    });
  }

  profileUpdated(userId: string, changedFields: string[]): void {
    this.publish('gateway.profile.updated', userId, { userId, changedFields });
  }
  avatarUpdated(userId: string): void {
    this.publish('gateway.profile.avatar_updated', userId, {
      userId,
      at: new Date().toISOString(),
    });
  }
  passwordChanged(userId: string, revokedSessions: number): void {
    this.publish('gateway.auth.password_changed', userId, {
      userId,
      at: new Date().toISOString(),
      revokedSessions,
    });
  }
  emailChangeRequested(userId: string): void {
    this.publish('gateway.profile.email_change_requested', userId, {
      userId,
      at: new Date().toISOString(),
    });
  }
  emailChanged(userId: string): void {
    this.publish('gateway.profile.email_changed', userId, {
      userId,
      at: new Date().toISOString(),
    });
  }
  twoFactorEnabled(userId: string): void {
    this.publish('gateway.auth.mfa_changed', userId, {
      userId,
      at: new Date().toISOString(),
      enabled: true,
    });
  }
  twoFactorDisabled(userId: string): void {
    this.publish('gateway.auth.mfa_changed', userId, {
      userId,
      at: new Date().toISOString(),
      enabled: false,
    });
  }
  sessionRevoked(
    userId: string,
    sessionId: string,
    reason: 'manual' | 'password_change' | 'revoke_others' | 'org_deactivated',
  ): void {
    this.publish('gateway.profile.session_revoked', userId, { userId, sessionId, reason });
  }
}
