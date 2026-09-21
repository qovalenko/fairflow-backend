import { MailGrpcController } from './mail.grpc.controller';
import type { NotificationService } from './notification.service';

describe('MailGrpcController — SendTransactionalEmail', () => {
  function make(sendTransactional: jest.Mock) {
    const notifications = { sendTransactional } as unknown as NotificationService;
    return new MailGrpcController(notifications);
  }

  it('maps snake_case and camelCase request fields onto sendTransactional', async () => {
    const sendTransactional = jest.fn().mockResolvedValue({
      status: 'sent',
      messageId: 'msg-abc',
    });
    const ctrl = make(sendTransactional);
    const res = await ctrl.sendTransactionalEmail({
      to: 'user@example.com',
      kind: 'verify_email',
      actionUrl: 'https://app/verify',
      userName: 'Alice',
      subject: 'Verify',
      title: 'Welcome',
      body: 'Click the link',
    });
    expect(sendTransactional).toHaveBeenCalledWith({
      to: 'user@example.com',
      kind: 'verify_email',
      action_url: 'https://app/verify',
      user_name: 'Alice',
      subject: 'Verify',
      title: 'Welcome',
      body: 'Click the link',
    });
    expect(res).toEqual({
      status: 'sent',
      message_id: 'msg-abc',
      messageId: 'msg-abc',
      error: '',
    });
  });

  it('defaults kind to generic and surfaces error status from the service', async () => {
    const sendTransactional = jest.fn().mockResolvedValue({
      status: 'failed',
      messageId: '',
      error: 'mailer disabled',
    });
    const ctrl = make(sendTransactional);
    const res = await ctrl.sendTransactionalEmail({ to: 'a@b.c' });
    expect(sendTransactional).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.c', kind: 'generic', action_url: '' }),
    );
    expect(res).toEqual({
      status: 'failed',
      message_id: '',
      messageId: '',
      error: 'mailer disabled',
    });
  });

  it('prefers snake_case action_url over camelCase when both are present', async () => {
    const sendTransactional = jest.fn().mockResolvedValue({ status: 'sent', messageId: 'm1' });
    const ctrl = make(sendTransactional);
    await ctrl.sendTransactionalEmail({
      action_url: 'https://snake',
      actionUrl: 'https://camel',
    });
    expect(sendTransactional).toHaveBeenCalledWith(
      expect.objectContaining({ action_url: 'https://snake' }),
    );
  });
});
