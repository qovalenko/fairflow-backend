import { ProfileEventsService } from './profile-events.service';
import type { AuthBusPublisherService } from './auth-bus-publisher.service';

describe('ProfileEventsService security-fact publishing', () => {
  let publish: jest.Mock;
  let bus: AuthBusPublisherService;
  let svc: ProfileEventsService;

  beforeEach(() => {
    publish = jest.fn().mockResolvedValue(undefined);
    bus = { publish } as unknown as AuthBusPublisherService;
    svc = new ProfileEventsService(bus);
  });

  it('profileUpdated publishes changed field names without values', () => {
    svc.profileUpdated('u1', ['name', 'timezone']);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gateway.profile.updated',
        source: 'auth',
        userId: 'u1',
        actorType: 'user',
        subject: 'user/u1',
        payload: { userId: 'u1', changedFields: ['name', 'timezone'] },
      }),
    );
  });

  it('avatarUpdated publishes gateway.profile.avatar_updated', () => {
    svc.avatarUpdated('u2');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gateway.profile.avatar_updated',
        userId: 'u2',
        payload: expect.objectContaining({ userId: 'u2', at: expect.any(String) }),
      }),
    );
  });

  it('passwordChanged publishes revoked session count', () => {
    svc.passwordChanged('u3', 4);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gateway.auth.password_changed',
        payload: expect.objectContaining({ userId: 'u3', revokedSessions: 4 }),
      }),
    );
  });

  it('emailChangeRequested and emailChanged publish profile email events', () => {
    svc.emailChangeRequested('u4');
    svc.emailChanged('u4');
    expect(publish).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'gateway.profile.email_change_requested', userId: 'u4' }),
    );
    expect(publish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'gateway.profile.email_changed', userId: 'u4' }),
    );
  });

  it('twoFactorEnabled/Disabled publish mfa_changed with enabled flag', () => {
    svc.twoFactorEnabled('u5');
    svc.twoFactorDisabled('u5');
    expect(publish).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'gateway.auth.mfa_changed',
        payload: expect.objectContaining({ enabled: true }),
      }),
    );
    expect(publish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'gateway.auth.mfa_changed',
        payload: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it('sessionRevoked carries session id and reason', () => {
    svc.sessionRevoked('u6', 'sess-1', 'password_change');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gateway.profile.session_revoked',
        payload: { userId: 'u6', sessionId: 'sess-1', reason: 'password_change' },
      }),
    );
  });
});
