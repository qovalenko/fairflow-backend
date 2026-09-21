/**
 * X1 — PII masking for email addresses that leave the mail path.
 *
 * A recipient address is personal data of a CLIENT (the automation `send_email`
 * final action mails `{{contact.email}}`), and this domain used to hand it out in
 * two places that outlive the request:
 *  - WARN log lines (`… to ${to} …`) — logs are shipped, retained and read by
 *    operators who have no business seeing a customer mailbox;
 *  - the `error` string of `EmailOutcome`, which travels back over gRPC into
 *    `order.lastError` (persistent order state rendered in the UI) and into
 *    `notification.email_error` in Mongo. nodemailer puts the envelope in its
 *    message ("550 5.1.1 <john.doe@example.com>: Recipient address rejected"),
 *    so a *raw* transport error leaks the address even when the code never
 *    interpolated it.
 *
 * The masking keeps the message DIAGNOSABLE: the domain, the SMTP status code and
 * the transport wording all survive — only the local part of the mailbox is
 * reduced to its first character. `john.doe@example.com` → `j***@example.com`,
 * which is enough for an operator to recognise the address they already know and
 * useless to someone harvesting a log.
 */

/**
 * Addresses inside free-form text. Deliberately permissive on the local part
 * (nodemailer/SMTP echo the envelope verbatim) and anchored on a dotted domain so
 * ordinary words containing `@` are left alone.
 */
const EMAIL_IN_TEXT = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * Mask ONE address: `local@domain` → `l***@domain`. The domain is kept (it is the
 * operationally useful half: MX/relay/typo diagnosis) and the local part is cut to
 * one character. A one-character local part is dropped entirely — `a***@x.tld`
 * would BE the address. Anything that is not an address comes back as `***`.
 */
export function maskEmail(value: string): string {
  const addr = (value ?? '').trim();
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return addr ? '***' : '';
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  return local.length > 1 ? `${local[0]}***@${domain}` : `***@${domain}`;
}

/**
 * Mask every address embedded in free-form text (transport errors, exception
 * messages). Everything that is not an address is preserved verbatim, so the
 * message stays diagnosable.
 */
export function maskEmailsInText(value: unknown): string {
  const text = value == null ? '' : String(value);
  return text.replace(EMAIL_IN_TEXT, (m) => maskEmail(m));
}
