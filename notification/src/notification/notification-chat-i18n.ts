import { pickNotifyLocale } from '@fairflow/shared';

const CHAT_I18N = {
  mention: {
    title: { ru: 'Вас упомянули в чате', en: 'You were mentioned in chat' },
    bodyFallback: { ru: 'Открыть беседу', en: 'Open conversation' },
  },
  message: {
    title: { ru: 'Новое сообщение', en: 'New message' },
    bodyFallback: { ru: 'Открыть беседу', en: 'Open conversation' },
  },
} as const;

export function renderChatNotificationCopy(
  isMention: boolean,
  preview: string,
  locale = 'ru',
): { title: string; body: string } {
  const spec = isMention ? CHAT_I18N.mention : CHAT_I18N.message;
  const title = pickNotifyLocale(spec.title, locale);
  const body = preview.trim() || pickNotifyLocale(spec.bodyFallback, locale);
  return { title, body };
}
