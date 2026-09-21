const sendMail = jest.fn();
const verify = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail, verify })),
}));

import { ConfigService } from '@nestjs/config';
import { MailerService } from './mailer.service';

function configOf(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as ConfigService;
}

describe('MailerService', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    sendMail.mockReset();
    verify.mockReset();
    verify.mockResolvedValue(true);
    sendMail.mockResolvedValue({ messageId: 'smtp-msg-1' });
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('is disabled (no-op) when MAIL_ENABLED is not true', async () => {
    const svc = new MailerService(configOf({ MAIL_ENABLED: 'false' }));
    svc.onModuleInit();
    expect(svc.isEnabled()).toBe(false);
    await expect(
      svc.sendMail({ to: 'a@b.c', subject: 's', html: '<p>x</p>', text: 'x' }),
    ).rejects.toThrow('mailer disabled');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('stays disabled when MAIL_ENABLED=true but MAIL_SMTP_HOST is empty', () => {
    const svc = new MailerService(
      configOf({ MAIL_ENABLED: 'true', MAIL_SMTP_HOST: '', MAIL_SMTP_PORT: '25' }),
    );
    svc.onModuleInit();
    expect(svc.isEnabled()).toBe(false);
  });

  it('constructs transport and sends mail with configured from/replyTo', async () => {
    const svc = new MailerService(
      configOf({
        MAIL_ENABLED: 'true',
        MAIL_SMTP_HOST: 'mail.test',
        MAIL_SMTP_PORT: '25',
        MAIL_FROM: 'FairFlow <noreply@test>',
        MAIL_REPLY_TO: 'support@test',
      }),
    );
    svc.onModuleInit();
    expect(svc.isEnabled()).toBe(true);
    const result = await svc.sendMail({
      to: 'user@test',
      subject: 'Hello',
      html: '<b>Hi</b>',
      text: 'Hi',
    });
    expect(result).toEqual({ messageId: 'smtp-msg-1' });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'FairFlow <noreply@test>',
        to: 'user@test',
        subject: 'Hello',
        replyTo: 'support@test',
      }),
    );
  });

  it('verify failure does not block sendMail (best-effort probe)', async () => {
    verify.mockRejectedValue(new Error('connection refused'));
    const svc = new MailerService(
      configOf({ MAIL_ENABLED: 'true', MAIL_SMTP_HOST: 'mail.test' }),
    );
    svc.onModuleInit();
    await expect(
      svc.sendMail({ to: 'a@b.c', subject: 's', html: 'h', text: 't' }),
    ).resolves.toEqual({ messageId: 'smtp-msg-1' });
  });
});
