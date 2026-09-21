import { emitAutomationEvent } from './event-emitter';

describe('emitAutomationEvent', () => {
  it('builds and publishes a canonical envelope (TODO-132)', async () => {
    const publishEnvelope = jest.fn(async () => undefined);
    await emitAutomationEvent({ publishEnvelope } as never, {
      type: 'automation.rule.updated',
      projectId: 'p1',
      payload: { rule_id: 'r1' },
    });
    expect(publishEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'automation.rule.updated',
        projectId: 'p1',
        source: 'automation',
        payload: { rule_id: 'r1' },
        messageId: expect.any(String),
        idempotencyKey: expect.any(String),
      }),
    );
  });
});
