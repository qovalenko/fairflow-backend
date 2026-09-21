import { NotificationService } from './notification.service';

const controlMembers = {
  getEffectiveModulesWithStatus: jest.fn().mockResolvedValue({ modules: [], ok: true }),
} as never;

describe('NotificationService email_mode (NFR-100)', () => {
  it('defaults to off in BOX edition', async () => {
    const prefsCol = { findOne: jest.fn().mockResolvedValue(null) };
    const mongo = {
      notifications: () => ({ findOne: jest.fn() }),
      preferences: () => prefsCol,
    };
    const pointCheck = { canSendEmail: jest.fn().mockResolvedValue(true) };
    const svc = new NotificationService(
      mongo as never,
      { isEnabled: () => false } as never,
      { resolveEmail: jest.fn() } as never,
      { publishBadge: jest.fn() } as never,
      { publishEnvelope: jest.fn() } as never,
      { recordSuppressed: jest.fn() } as never,
      pointCheck as never,
      controlMembers,
    );
    const prefs = await svc.getPreferences('u1');
    expect(prefs.email_mode).toBe('off');
  });

  it('sendEmail skips when email_mode is off even if mailer enabled', async () => {
    const prefsCol = {
      findOne: jest.fn().mockResolvedValue({ user_id: 'u1', email_mode: 'off', categories: [] }),
    };
    const mongo = {
      notifications: () => ({ findOne: jest.fn() }),
      preferences: () => prefsCol,
    };
    const mailer = { isEnabled: () => true, sendMail: jest.fn() };
    const pointCheck = { canSendEmail: jest.fn().mockResolvedValue(true) };
    const svc = new NotificationService(
      mongo as never,
      mailer as never,
      { resolveEmail: async () => 'a@b.c' } as never,
      { publishBadge: jest.fn() } as never,
      { publishEnvelope: jest.fn() } as never,
      { recordSuppressed: jest.fn() } as never,
      pointCheck as never,
      controlMembers,
    );
    const out = await (
      svc as unknown as {
        sendEmail: (r: unknown) => Promise<{ status: string; error?: string }>;
      }
    ).sendEmail({
      id: 'n1',
      user_id: 'u1',
      project_id: 'p1',
      title: 'T',
      body: 'B',
      data_json: '{}',
    });
    expect(out).toEqual({ status: 'skipped', error: 'email_mode_off' });
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });
});
