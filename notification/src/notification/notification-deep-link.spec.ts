import { buildMatrixDeepLink } from './notification-deep-link';

describe('buildMatrixDeepLink', () => {
  const baseEnv = {
    projectId: 'p1',
    messageId: 'm1',
    subject: 'deal/d-42',
    payload: {},
  };

  it('builds deal deep links from payload id', () => {
    const link = buildMatrixDeepLink(
      'crm.deal.reassigned',
      {
        ...baseEnv,
        payload: { dealId: 'd-99' },
      } as never,
      'deal',
      'd-42',
    );
    expect(link).toBe('/deals/d-99');
  });

  it('builds order deep link for final_action_failed', () => {
    const link = buildMatrixDeepLink(
      'crm.order.final_action_failed',
      {
        ...baseEnv,
        subject: 'order/o-7',
        payload: { orderId: 'o-7' },
      } as never,
      'order',
      'o-7',
    );
    expect(link).toBe('/orders/o-7');
  });

  it('builds shared-record deep link from entity type', () => {
    const link = buildMatrixDeepLink(
      'control.record.shared',
      {
        ...baseEnv,
        payload: { entityType: 'contact', entityId: 'c-1' },
      } as never,
      '',
      '',
    );
    expect(link).toBe('/contacts/c-1');
  });

  it('returns projects list for archived project events', () => {
    const link = buildMatrixDeepLink('control.project.archived', baseEnv as never, '', '');
    expect(link).toBe('/account/projects');
  });

  it('builds activity deep links from payload activityId', () => {
    const link = buildMatrixDeepLink(
      'crm.activity.overdue',
      {
        ...baseEnv,
        subject: 'activity/a-55',
        payload: { activityId: 'a-55' },
      } as never,
      'activity',
      'a-55',
    );
    expect(link).toBe('/activities/a-55');
  });

  it('builds role settings links for role assignment events', () => {
    const link = buildMatrixDeepLink(
      'control.role.assigned',
      { ...baseEnv, projectId: 'p-settings' } as never,
      '',
      '',
    );
    expect(link).toBe('/account/projects/p-settings/settings');
  });

  it('builds billing and drift entity links', () => {
    expect(buildMatrixDeepLink('billing.quota.exceeded', baseEnv as never, '', '')).toBe(
      '/billing',
    );
    expect(
      buildMatrixDeepLink(
        'crm.contact.drift',
        { ...baseEnv, payload: { contactId: 'c-9' } } as never,
        'contact',
        '',
      ),
    ).toBe('/contacts/c-9');
    expect(
      buildMatrixDeepLink(
        'crm.company.drift',
        { ...baseEnv, payload: { companyId: 'co-1' } } as never,
        'company',
        '',
      ),
    ).toBe('/companies/co-1');
  });
});
