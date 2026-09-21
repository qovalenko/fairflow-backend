/**
 * Dependency-free email rendering. Produces a branded, table-based HTML body
 * (mail-client safe) plus a plain-text fallback. Two entry points:
 *  - {@link renderNotificationEmail} — feed/event notifications.
 *  - {@link renderTransactionalEmail} — auth flows (verify-email, password reset,
 *    email change). Inputs are server-curated, but we HTML-escape defensively.
 */

export type EmailContent = { subject: string; html: string; text: string };

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SEVERITY_COLOR: Record<string, string> = {
  info: '#2563eb',
  important: '#d97706',
  critical: '#dc2626',
};
const BRAND_COLOR = '#2563eb';

type LayoutInput = {
  color: string;
  title: string; // already escaped
  bodyHtml: string; // already escaped (+<br/>)
  ctaUrl?: string;
  ctaLabel?: string;
  footerHtml: string; // already escaped/safe
};

/** Shared mail-client-safe table layout. Caller pre-escapes title/body/footer. */
function layout(input: LayoutInput): string {
  const cta = input.ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:20px 0 4px;">` +
      `<a href="${esc(input.ctaUrl)}" style="display:inline-block;background:${input.color};color:#ffffff;` +
      `text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600;font-size:14px;">` +
      `${esc(input.ctaLabel ?? 'Открыть FairFlow')}</a></td></tr></table>`
    : '';
  return (
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"/></head>` +
    `<body style="margin:0;padding:0;background:#f3f4f6;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" ` +
    `style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;max-width:560px;width:100%;">` +
    `<tr><td style="background:${input.color};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>` +
    `<tr><td style="padding:28px 32px 6px;"><div style="font-size:12px;color:#9ca3af;font-weight:700;letter-spacing:.08em;">FAIRFLOW</div></td></tr>` +
    `<tr><td style="padding:0 32px 4px;"><h1 style="margin:0;font-size:20px;line-height:1.3;color:#111827;">${input.title}</h1></td></tr>` +
    `<tr><td style="padding:10px 32px 0;"><p style="margin:0;font-size:15px;line-height:1.55;color:#374151;">${input.bodyHtml}</p></td></tr>` +
    `<tr><td style="padding:0 32px 28px;">${cta}</td></tr>` +
    `<tr><td style="padding:16px 32px;border-top:1px solid #f3f4f6;font-size:12px;line-height:1.5;color:#9ca3af;">${input.footerHtml}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

export type NotificationEmailInput = {
  title: string;
  body: string;
  severity?: 'info' | 'important' | 'critical';
  /** Optional deep-link CTA (e.g. open the deal/chat in the app). */
  ctaUrl?: string;
  ctaLabel?: string;
  /** Link to /account/notifications so the user can tune what they receive. */
  preferencesUrl?: string;
};

export function renderNotificationEmail(input: NotificationEmailInput): EmailContent {
  const color = SEVERITY_COLOR[input.severity ?? 'info'] ?? BRAND_COLOR;
  const prefsHtml = input.preferencesUrl
    ? ` <a href="${esc(input.preferencesUrl)}" style="color:#9ca3af;">Настроить уведомления</a>.`
    : '';
  const html = layout({
    color,
    title: esc(input.title),
    bodyHtml: esc(input.body).replace(/\n/g, '<br/>'),
    ctaUrl: input.ctaUrl,
    ctaLabel: input.ctaLabel,
    footerHtml: `Это автоматическое уведомление FairFlow, отвечать на него не нужно.${prefsHtml}`,
  });

  const textParts: string[] = [input.title, '', input.body];
  if (input.ctaUrl) textParts.push('', `${input.ctaLabel ?? 'Открыть'}: ${input.ctaUrl}`);
  textParts.push('', '—', 'Это автоматическое уведомление FairFlow.');
  if (input.preferencesUrl) textParts.push(`Настроить уведомления: ${input.preferencesUrl}`);

  return { subject: input.title, html, text: textParts.join('\n') };
}

export type TransactionalKind =
  | 'verify_email'
  | 'password_reset'
  | 'email_change'
  | 'email_change_alert'
  | 'org_invitation'
  | 'project_invitation'
  /** Machine-sent mail from an automation action / order final action (TODO-039). */
  | 'automation'
  | 'generic';

export type TransactionalEmailInput = {
  kind: TransactionalKind;
  actionUrl: string;
  userName?: string;
  /** Optional copy overrides. */
  subject?: string;
  title?: string;
  body?: string;
};

const TRANSACTIONAL_COPY: Record<
  TransactionalKind,
  { subject: string; title: string; body: string; cta: string; note: string }
> = {
  verify_email: {
    subject: 'Подтвердите вашу почту',
    title: 'Подтвердите адрес электронной почты',
    body: 'Чтобы завершить регистрацию в FairFlow, подтвердите, что этот адрес принадлежит вам.',
    cta: 'Подтвердить почту',
    note: 'Если вы не регистрировались в FairFlow, просто проигнорируйте это письмо.',
  },
  password_reset: {
    subject: 'Сброс пароля FairFlow',
    title: 'Сброс пароля',
    body: 'Вы запросили сброс пароля. Нажмите кнопку ниже, чтобы задать новый пароль. Ссылка действует 1 час.',
    cta: 'Задать новый пароль',
    note: 'Если вы не запрашивали сброс пароля, проигнорируйте это письмо — ваш пароль не изменится.',
  },
  email_change: {
    subject: 'Подтвердите смену почты',
    title: 'Подтверждение смены адреса',
    body: 'Подтвердите, что хотите использовать этот адрес электронной почты в FairFlow.',
    cta: 'Подтвердить смену',
    note: 'Если вы не запрашивали смену адреса, проигнорируйте это письмо.',
  },
  email_change_alert: {
    subject: 'Запрошена смена почты — FairFlow',
    title: 'Запрошена смена адреса',
    body: 'Кто-то запросил смену адреса электронной почты для вашей учётной записи FairFlow. Если это были не вы, отмените запрос.',
    cta: 'Отменить смену',
    note: 'Если вы сами инициировали смену, подтвердите новый адрес из второго письма.',
  },
  org_invitation: {
    subject: 'Приглашение в организацию — FairFlow',
    title: 'Вас пригласили в организацию',
    body: 'Вас пригласили присоединиться к организации в FairFlow. Нажмите кнопку ниже, чтобы принять приглашение и создать учётную запись.',
    cta: 'Принять приглашение',
    note: 'Если вы не ожидали этого приглашения, просто проигнорируйте это письмо.',
  },
  project_invitation: {
    subject: 'Приглашение в проект — FairFlow',
    title: 'Вас пригласили в проект',
    body: 'Вас пригласили присоединиться к проекту в FairFlow. Нажмите кнопку ниже, чтобы принять приглашение.',
    cta: 'Принять приглашение',
    note: 'Если вы не ожидали этого приглашения, просто проигнорируйте это письмо.',
  },
  automation: {
    subject: 'Уведомление FairFlow',
    title: 'FairFlow',
    // Subject/title/body are always overridden by the automation action config;
    // only the footer note below is template copy.
    body: 'Уведомление отправлено автоматизацией FairFlow.',
    cta: 'Открыть FairFlow',
    note: 'Письмо отправлено автоматически, отвечать на него не нужно.',
  },
  generic: {
    subject: 'Уведомление FairFlow',
    title: 'FairFlow',
    body: 'Подтвердите действие по кнопке ниже.',
    cta: 'Открыть FairFlow',
    note: 'Если письмо пришло по ошибке, проигнорируйте его.',
  },
};

export function renderTransactionalEmail(input: TransactionalEmailInput): EmailContent {
  const copy = TRANSACTIONAL_COPY[input.kind] ?? TRANSACTIONAL_COPY.generic;
  const subject = input.subject ?? copy.subject;
  const title = input.title ?? copy.title;
  const body = input.body ?? copy.body;
  const greeting = input.userName ? `${input.userName}, ` : '';
  const bodyText = `${greeting}${body}`;

  // The CTA fallback block only makes sense when there IS a link: machine-sent
  // mail (kind `automation`) has no action URL, and the old unconditional
  // footer rendered a bare `<a href="">` plus a dangling "Открыть FairFlow: ".
  const hasAction = !!input.actionUrl;
  const html = layout({
    color: BRAND_COLOR,
    title: esc(title),
    bodyHtml: esc(bodyText).replace(/\n/g, '<br/>'),
    ctaUrl: input.actionUrl,
    ctaLabel: copy.cta,
    footerHtml: hasAction
      ? `${esc(copy.note)}<br/><br/>Если кнопка не работает, скопируйте ссылку в браузер:<br/>` +
        `<a href="${esc(input.actionUrl)}" style="color:#9ca3af;word-break:break-all;">${esc(input.actionUrl)}</a>`
      : esc(copy.note),
  });

  const text = [
    title,
    '',
    bodyText,
    ...(hasAction ? ['', `${copy.cta}: ${input.actionUrl}`] : []),
    '',
    '—',
    copy.note,
  ].join('\n');

  return { subject, html, text };
}
