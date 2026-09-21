import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export type SendMailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

export type SendMailResult = { messageId: string };

/**
 * SMTP delivery wrapper around nodemailer.
 *
 * Transport target is the shared outbound relay (host-Postfix on the mail host
 * relaying through Yandex Postbox). The relay trusts the LAN/pod source via
 * Postfix `permit_mynetworks`, so NO SMTP auth is used by default; the pod must
 * reach it by the LAN IP (`hostAliases: smtp.example.com -> <mail-host-lan-ip>`), never
 * the public IP (router-NAT would drop the source out of `mynetworks`). From the
 * envelope MUST be `<local>@example.com` (Postbox identity = your mail domain).
 *
 * Fail-safe: when MAIL_ENABLED!=true (e.g. local dev / feature stands) the mailer
 * is a no-op and {@link isEnabled} returns false, so callers degrade to in-app
 * only without errors. A failed `verify()` never blocks startup.
 */
@Injectable()
export class MailerService implements OnModuleInit {
  private readonly logger = new Logger(MailerService.name);
  private transporter: Transporter | null = null;
  private readonly enabled: boolean;
  private readonly from: string;
  private readonly replyTo?: string;

  constructor(private readonly config: ConfigService) {
    this.enabled = (this.config.get<string>('MAIL_ENABLED') ?? 'false').toLowerCase() === 'true';
    this.from = this.config.get<string>('MAIL_FROM') ?? 'FairFlow <notifications@example.com>';
    this.replyTo = this.config.get<string>('MAIL_REPLY_TO') || undefined;
  }

  /** True only when enabled AND a transport was successfully constructed. */
  isEnabled(): boolean {
    return this.enabled && this.transporter !== null;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('mailer disabled (MAIL_ENABLED!=true) — email delivery is a no-op');
      return;
    }
    const host = this.config.get<string>('MAIL_SMTP_HOST');
    if (!host) {
      this.logger.warn('MAIL_ENABLED=true but MAIL_SMTP_HOST is empty — mailer stays disabled');
      return;
    }
    const port = parseInt(this.config.get<string>('MAIL_SMTP_PORT') ?? '25', 10);
    const secure =
      (this.config.get<string>('MAIL_SMTP_SECURE') ?? 'false').toLowerCase() === 'true';
    const requireTLS =
      (this.config.get<string>('MAIL_SMTP_STARTTLS') ?? 'true').toLowerCase() === 'true';
    const user = this.config.get<string>('MAIL_SMTP_USER') || '';
    const pass = this.config.get<string>('MAIL_SMTP_PASS') || '';
    const rejectUnauthorized =
      (this.config.get<string>('MAIL_SMTP_TLS_REJECT_UNAUTHORIZED') ?? 'true').toLowerCase() ===
      'true';

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure, // false on :25 — TLS is negotiated via STARTTLS
      requireTLS,
      ...(user ? { auth: { user, pass } } : {}),
      tls: { rejectUnauthorized },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    // Best-effort connectivity probe; logged only, never blocks bootstrap.
    this.transporter.verify().then(
      () => this.logger.log(`mailer ready -> ${host}:${port} (from "${this.from}")`),
      (err: unknown) =>
        this.logger.warn(`mailer verify failed (will retry on send): ${String(err)}`),
    );
  }

  async sendMail(input: SendMailInput): Promise<SendMailResult> {
    if (!this.transporter) {
      throw new Error('mailer disabled');
    }
    const info = (await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.replyTo ?? this.replyTo,
    })) as { messageId?: string };
    return { messageId: String(info.messageId ?? '') };
  }
}
