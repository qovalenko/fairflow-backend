import {
  getAddresseeHandler,
  matrixRoutingKeys,
  notifyTemplateVars,
  payloadOwner,
} from './notification-consumer-handlers';

describe('notification-consumer-handlers', () => {
  it('payloadOwner collects assignee and owner aliases from payload', () => {
    expect(
      payloadOwner({
        assigneeId: 'u1',
        ownerUserId: 'u2',
        toUserId: 'u3',
        recipientUserId: 'u4',
      }),
    ).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('resolve addressees for deal reassigned from payload owner', () => {
    const handler = getAddresseeHandler('crm.deal.reassigned');
    expect(handler?.addressees({ payload: { assigneeId: 'u-new' } } as never)).toEqual(['u-new']);
  });

  it('resolve visibility narrowed addressees from metadata.userIds', () => {
    const handler = getAddresseeHandler('control.visibility.narrowed');
    expect(
      handler?.addressees({
        payload: { metadata: { userIds: ['u1', 'u2'] } },
      } as never),
    ).toEqual(['u1', 'u2']);
  });

  it('automation failure fans out to pa with empty payload addressees', () => {
    const handler = getAddresseeHandler('automation.action.failed');
    expect(handler?.addressees({ payload: { ruleId: 'r1' } } as never)).toEqual([]);
    expect(handler?.fanout).toEqual(['pa']);
  });

  it('notifyTemplateVars builds i18n placeholders from payload and metadata', () => {
    const vars = notifyTemplateVars(
      {
        projectId: 'p1',
        payload: {
          dealId: 'd-42',
          metric: 'amount',
          role: 'manager',
          metadata: {
            from: 'new',
            to: 'won',
            expiresAt: '2026-12-31T00:00:00Z',
            actorName: 'Alice',
          },
        },
      } as never,
      'deal',
      'd-42',
      getAddresseeHandler('crm.deal.stage_changed'),
    );
    expect(vars).toMatchObject({
      entityType: 'deal',
      entityId: 'd-42',
      projectId: 'p1',
      metric: 'amount',
      dealId: 'd-42',
      role: 'manager',
      from: 'new',
      to: 'won',
      actorName: 'Alice',
      expiresAt: '2026-12-31',
    });
    expect(vars.entityLabel).toContain('d-42');
  });

  it('matrixRoutingKeys exposes every catalog event type', () => {
    expect(matrixRoutingKeys()).toContain('crm.deal.reassigned');
    expect(matrixRoutingKeys()).toContain('crm.activity.reminder');
  });

  it('stage_changed addressees include mover and owner', () => {
    const handler = getAddresseeHandler('crm.deal.stage_changed');
    expect(
      handler?.addressees({
        payload: { assigneeId: 'u1', movedBy: 'u2' },
      } as never),
    ).toEqual(['u1', 'u2']);
  });

  it('role revoked addressees come from subjectUserId', () => {
    const handler = getAddresseeHandler('control.role.revoked');
    expect(handler?.addressees({ payload: { subjectUserId: 'u-target' } } as never)).toEqual([
      'u-target',
    ]);
  });
});
