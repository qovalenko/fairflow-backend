import { renderChatNotificationCopy } from './notification-chat-i18n';

describe('renderChatNotificationCopy (NFR-080)', () => {
  it('renders mention copy from the i18n map', () => {
    expect(renderChatNotificationCopy(true, '')).toEqual({
      title: 'Вас упомянули в чате',
      body: 'Открыть беседу',
    });
  });

  it('uses the preview as the body when present', () => {
    expect(renderChatNotificationCopy(false, 'Привет')).toEqual({
      title: 'Новое сообщение',
      body: 'Привет',
    });
  });
});
