import { payloadEntityLabel, quotedLabel } from './notification-human-context';

describe('notification-human-context', () => {
  it('prefers flat name fields over raw ids', () => {
    expect(payloadEntityLabel({ name: 'Сделка №5', dealId: 'd-1' }, ['dealId'])).toBe(
      'Сделка №5',
    );
    expect(payloadEntityLabel({ dealName: 'Заказ клиента', orderId: 'o-9' }, ['orderId'])).toBe(
      'Заказ клиента',
    );
  });

  it('reads humanContext.displayName when present', () => {
    expect(
      payloadEntityLabel({ humanContext: { displayName: 'Иванов И.И.' }, dealId: 'd-1' }, [
        'dealId',
      ]),
    ).toBe('Иванов И.И.');
  });

  it('falls back to id keys and quotes safely', () => {
    expect(payloadEntityLabel({ dealId: 'd-1' }, ['dealId'])).toBe('d-1');
    expect(quotedLabel('Сделка №5')).toBe('«Сделка №5»');
    expect(quotedLabel('')).toBe('');
  });
});
