import { emitNotificationEvent } from './event-emitter';

describe('emitNotificationEvent', () => {
  it('publishes a registered notification routing key envelope', async () => {
    const publishEnvelope = jest.fn(async () => undefined);
    await emitNotificationEvent({ publishEnvelope } as never, {
      type: 'notification.preferences.changed',
      payload: { user_id: 'u1' },
      userId: 'u1',
    });
    expect(publishEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification.preferences.changed',
        source: 'notification',
        userId: 'u1',
        payload: { user_id: 'u1' },
      }),
    );
  });
});
