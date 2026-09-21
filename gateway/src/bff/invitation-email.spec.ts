import { of, throwError } from 'rxjs';

import { V1DataBffController } from './v1-data-bff.controller';

/**
 * Unit coverage for the "cold invitation" email path (P8 T2.4): the gateway BFF
 * must route the invite through notification's transactional-email RPC (the raw
 * `to` / project-less SMTP path auth uses), NOT the in-app `Send` RPC that needs
 * project_id+user_id. We exercise the private `sendInvitationEmail` on a bare
 * instance with the four collaborators it touches stubbed.
 */
describe('V1DataBffController.sendInvitationEmail (cold invite → transactional email)', () => {
  const PUBLIC_URL = 'https://app.example.test';

  function makeController(sendImpl: (payload: unknown) => unknown) {
    const sendTransactionalEmail = jest.fn((payload: unknown) => sendImpl(payload));
    const logger = { error: jest.fn() };
    // Bare instance — bypass DI; wire only what sendInvitationEmail reads.
    // Written through a loose record to sidestep the class's private fields.
    const ctrl = Object.create(V1DataBffController.prototype) as V1DataBffController;
    const wire = ctrl as unknown as Record<string, unknown>;
    wire.notification = { sendTransactionalEmail };
    wire.outboundMeta = { build: jest.fn(() => ({})) };
    wire.config = { appPublicUrl: PUBLIC_URL };
    wire.logger = logger;
    return { ctrl, sendTransactionalEmail, logger };
  }

  const invoke = (ctrl: unknown, raw: Record<string, unknown>) =>
    (
      ctrl as {
        sendInvitationEmail: (req: unknown, raw: Record<string, unknown>) => Promise<boolean>;
      }
    ).sendInvitationEmail({ user: { userId: 'u1' } }, raw);

  it('sends via transactional RPC with kind=org_invitation and the accept URL (no user_id)', async () => {
    const { ctrl, sendTransactionalEmail } = makeController(() =>
      of({ status: 'sent', message_id: 'm1' }),
    );
    const emailSent = await invoke(ctrl, {
      id: 'inv1',
      token: 'tok 123/x', // contains chars that must be URL-encoded
      email: '  invitee@example.com  ',
      organization_id: 'org1',
      role: 'employee',
    });

    expect(emailSent).toBe(true);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    const payload = sendTransactionalEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      to: 'invitee@example.com', // trimmed
      kind: 'org_invitation',
      action_url: `${PUBLIC_URL}/auth/invite/${encodeURIComponent('tok 123/x')}`,
    });
    // Cold invite must NOT carry a user_id / project_id addressing.
    expect(payload).not.toHaveProperty('user_id');
    expect(payload).not.toHaveProperty('project_id');
  });

  it('returns false and logs an error when delivery status is not "sent"', async () => {
    const { ctrl, logger } = makeController(() => of({ status: 'failed', error: 'smtp_down' }));
    const emailSent = await invoke(ctrl, { id: 'inv2', token: 't', email: 'a@b.co' });
    expect(emailSent).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain('failed');
  });

  it('returns false and logs when the RPC throws (mailer unreachable)', async () => {
    const { ctrl, logger } = makeController(() => throwError(() => new Error('unavailable')));
    const emailSent = await invoke(ctrl, { id: 'inv3', token: 't', email: 'a@b.co' });
    expect(emailSent).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('skips (false) and logs when token or email is missing — never calls the RPC', async () => {
    const { ctrl, sendTransactionalEmail, logger } = makeController(() => of({ status: 'sent' }));

    expect(await invoke(ctrl, { id: 'inv4', token: 't', email: '' })).toBe(false);
    expect(await invoke(ctrl, { id: 'inv5', token: '', email: 'a@b.co' })).toBe(false);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
