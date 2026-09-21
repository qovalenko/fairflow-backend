import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { NotificationService } from './notification.service';

/**
 * Transactional (project-less) email endpoint for auth flows: verify-email,
 * password reset, email change. Deliberately NOT decorated with
 * `@RequireModule('notifications')` — these mails are account-level, not bound to
 * a project's enabled modules. Still protected by the global inbound gateway-key
 * guard (only the gateway can call it).
 */
@Controller()
export class MailGrpcController {
  constructor(private readonly notifications: NotificationService) {}

  @GrpcMethod('NotificationGrpc', 'SendTransactionalEmail')
  async sendTransactionalEmail(data: {
    to?: string;
    kind?: string;
    action_url?: string;
    actionUrl?: string;
    user_name?: string;
    userName?: string;
    subject?: string;
    title?: string;
    body?: string;
  }) {
    const outcome = await this.notifications.sendTransactional({
      to: data.to ?? '',
      kind: data.kind ?? 'generic',
      action_url: data.action_url ?? data.actionUrl ?? '',
      user_name: data.user_name ?? data.userName,
      subject: data.subject,
      title: data.title,
      body: data.body,
    });
    // Return both key forms so serialization is correct regardless of the
    // server's proto-loader keepCase setting.
    return {
      status: outcome.status,
      message_id: outcome.messageId ?? '',
      messageId: outcome.messageId ?? '',
      error: outcome.error ?? '',
    };
  }
}
