import { MemberOffboardedConsumer } from './member-offboarded.consumer';

describe('MemberOffboardedConsumer (FR-AUTOM-105)', () => {
  it('disables rules for departing user', async () => {
    const automation = {
      disableRulesForInactiveActor: jest.fn(async () => ({ disabled_rules: 2 })),
    };
    const consumer = new MemberOffboardedConsumer({} as never, automation as never);
    const outcome = await consumer.handle({
      projectId: 'p1',
      type: 'control.member.offboarded',
      payload: { metadata: { departingUserId: 'u9' } },
    } as never);
    expect(outcome).toBe('ack');
    expect(automation.disableRulesForInactiveActor).toHaveBeenCalledWith('p1', 'u9');
  });

  it('dead-letters poison messages', async () => {
    const consumer = new MemberOffboardedConsumer({} as never, { disableRulesForInactiveActor: jest.fn() } as never);
    await expect(consumer.handle({ projectId: '', payload: {} } as never)).resolves.toBe('dead');
  });
});
