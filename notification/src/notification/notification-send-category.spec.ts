import { resolveSendCategory } from './notification-send-category';

describe('resolveSendCategory (TODO-404)', () => {
  it('keeps an explicit category', () => {
    expect(
      resolveSendCategory({
        category: 'sales',
        event_type: 'crm.order.final_action_failed',
      }),
    ).toEqual({ category: 'sales', event_type: 'crm.order.final_action_failed' });
  });

  it('infers category from event_type via the notification registry', () => {
    expect(
      resolveSendCategory({
        event_type: 'crm.activity.overdue',
      }),
    ).toEqual({ category: 'activities', event_type: 'crm.activity.overdue' });
  });

  it('reads event_type from data_json when the proto field is absent', () => {
    expect(
      resolveSendCategory({
        data_json: JSON.stringify({ eventType: 'crm.deal.won' }),
      }),
    ).toEqual({ category: 'deals', event_type: 'crm.deal.won' });
  });

  it('falls back to data when neither category nor event_type is provided', () => {
    expect(resolveSendCategory({})).toEqual({ category: 'data', event_type: '' });
  });
});
