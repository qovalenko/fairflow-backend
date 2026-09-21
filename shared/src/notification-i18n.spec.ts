import { pickNotifyLocale, renderNotifyI18n, renderNotifyTemplate } from './notification-i18n';

describe('notification-i18n', () => {
  it('renders {{var}} placeholders', () => {
    expect(renderNotifyTemplate('Сделка {{entityLabel}} назначена', { entityLabel: '№5' })).toBe(
      'Сделка №5 назначена',
    );
  });

  it('prefers ru locale then en', () => {
    const out = renderNotifyI18n(
      {
        title: { ru: 'Заголовок {{x}}', en: 'Title {{x}}' },
        body: { ru: 'Тело', en: 'Body' },
      },
      { x: 'A' },
      'ru',
    );
    expect(out.title).toBe('Заголовок A');
    expect(out.body).toBe('Тело');
  });

  it('falls back to en when preferred locale missing', () => {
    expect(pickNotifyLocale({ en: 'Hello' }, 'de')).toBe('Hello');
  });
});
