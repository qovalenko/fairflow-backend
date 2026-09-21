import { NotificationService } from './notification.service';
import type { MailerService } from '../mail/mailer.service';
import type { MongoService } from '../mongo/mongo.service';
import type { NotificationSignalService } from '../realtime/notification-signal.service';
import type { UserDirectoryService } from '../mail/user-directory.service';

/**
 * X1 — a client mailbox must not survive into a log line or into an `error`
 * string, because both outlive the request: logs are shipped/retained, and the
 * `error` of a transactional send is copied by automation straight into
 * `order.lastError` — persistent order state rendered in the UI.
 *
 * What must NOT change: the addressee stays intact in `EmailOutcome.to` (it is
 * this domain's own `email_to` field, used for resend), and the failure stays
 * diagnosable — masking removes the mailbox, not the SMTP wording.
 */
describe('NotificationService — no client mailbox in logs / error strings (X1)', () => {
  type Warn = string[];

  function build(opts: { enabled: boolean; sendMail?: () => Promise<{ messageId: string }> }) {
    const warnings: Warn = [];
    const mailer = {
      isEnabled: () => opts.enabled,
      sendMail: opts.sendMail ?? (async () => ({ messageId: 'm-1' })),
    } as unknown as MailerService;
    const directory = { resolveEmail: async () => '' } as unknown as UserDirectoryService;
    const signal = { publishBadge: () => undefined } as unknown as NotificationSignalService;
    const rabbit = { publishEnvelope: async () => undefined };
    const metrics = { recordCreated: jest.fn(), recordSuppressed: jest.fn(), recordEmailSent: jest.fn(), recordEmailFailed: jest.fn() };
    const pointCheck = { canSendEmail: jest.fn().mockResolvedValue(true) };
    const prefsCol = {
      findOne: jest.fn().mockResolvedValue({ user_id: 'u-1', email_mode: 'immediate', categories: [] }),
    };
    const mongo = {
      notifications: () => ({ findOne: jest.fn() }),
      preferences: () => prefsCol,
    } as unknown as MongoService;
    const svc = new NotificationService(
      mongo,
      mailer,
      directory,
      signal,
      rabbit as never,
      metrics as never,
      pointCheck as never,
      {
        getEffectiveModulesWithStatus: jest.fn().mockResolvedValue({ modules: [], ok: true }),
      } as never,
    );
    (svc as unknown as { logger: { warn: (m: string) => void } }).logger = {
      warn: (m: string) => warnings.push(m),
    } as never;
    return { svc, warnings };
  }

  const input = {
    to: 'john.doe@example.com',
    kind: 'automation',
    action_url: '',
    subject: 'S',
    body: 'B',
  };

  it('mailer disabled: the WARN line carries a masked address', async () => {
    const { svc, warnings } = build({ enabled: false });

    const out = await svc.sendTransactional(input);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('john.doe@example.com');
    expect(warnings[0]).toContain('j***@example.com');
    // the reason stays readable and the addressee survives in the RESULT
    expect(warnings[0]).toContain('mailer disabled');
    expect(out).toEqual({
      status: 'skipped',
      to: 'john.doe@example.com',
      error: 'mailer_disabled',
    });
  });

  it('transport failure: neither the log nor the returned error leaks the mailbox', async () => {
    const { svc, warnings } = build({
      enabled: true,
      sendMail: async () => {
        // nodemailer echoes the envelope back in its message — this is the leak
        // the executor could not have avoided by "just not interpolating `to`".
        throw new Error('550 5.1.1 <john.doe@example.com>: Recipient address rejected');
      },
    });

    const out = await svc.sendTransactional(input);

    expect(out.status).toBe('failed');
    expect(out.error).not.toContain('john.doe@example.com');
    expect(out.error).toContain('j***@example.com');
    // …and it is still an actionable diagnosis, not a blanked-out string
    expect(out.error).toContain('550 5.1.1');
    expect(out.error).toContain('Recipient address rejected');
    // the addressee itself is NOT masked in `to` (own field, used for resend)
    expect(out.to).toBe('john.doe@example.com');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('john.doe@example.com');
    expect(warnings[0]).toContain('j***@example.com');
  });

  it('fan-out email failure (notification feed) is masked the same way', async () => {
    const { svc, warnings } = build({
      enabled: true,
      sendMail: async () => {
        throw new Error('EENVELOPE Invalid recipient buyer@client.co');
      },
    });
    const row = {
      user_id: 'u-1',
      project_id: 'p-1',
      title: 'T',
      body: 'B',
      severity: 'info',
      data_json: '{}',
      email_to: 'buyer@client.co',
      event_type: 'crm.deal.won',
      channels: ['email'],
    };

    const out = await (
      svc as unknown as {
        sendEmail: (r: unknown) => Promise<{ status: string; to?: string; error?: string }>;
      }
    ).sendEmail(row);

    expect(out.status).toBe('failed');
    expect(out.error).not.toContain('buyer@client.co');
    expect(out.error).toContain('b***@client.co');
    expect(out.error).toContain('EENVELOPE');
    expect(warnings[0]).not.toContain('buyer@client.co');
    expect(warnings[0]).toContain('b***@client.co');
    // the event type stays in the line — that is what makes it triageable
    expect(warnings[0]).toContain('crm.deal.won');
  });
});
