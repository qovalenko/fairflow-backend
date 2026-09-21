/**
 * Нормализация дедуп-ключей контакта (`emailNormalized` / `phoneNormalized`).
 *
 * Вынесено из `contacts.service.ts` отдельным модулем НЕ ради красоты: те же
 * функции обязана использовать разовая миграция пересчёта ключей
 * (`scripts/backfill-normalized-keys.ts`). Копия правил в скрипте разъехалась бы
 * с доменом при первой же правке нормализации, и уникальный индекс снова начал
 * бы пропускать дубли — только уже молча.
 */

/** Normalize an email for dedup: lowercase + trim. Empty → undefined (so unset, not ''). */
export function normalizeEmail(email?: string | null): string | undefined {
  const v = (email ?? '').trim().toLowerCase();
  return v ? v : undefined;
}

/**
 * Country code assumed for a phone typed without `+` (коробка — РФ).
 * Вынесено в константу: для инсталляции с другим основным кодом менять здесь.
 */
export const DEFAULT_PHONE_COUNTRY_CODE = '7';

/**
 * TODO-166: нормализация телефона к E.164 для дедупа.
 *
 * Было: `digits` c сохранением ведущего `+`. Один и тот же номер давал ТРИ разных
 * ключа — `89123456789`, `79123456789`, `+79123456789` — поэтому партиал-уникальный
 * индекс не ловил дубль, а дедуп-радар и очередь дублей не считали такие записи
 * одинаковыми. Приводим национальную запись (`8 912 …`, `912 …`) к `+7 912 …`.
 *
 * Фолбэк сознательно мягкий: номер, который не разобрался ни в один известный
 * формат, возвращается как раньше (голые цифры) — нормализация не должна ронять
 * создание контакта с нестандартным номером.
 *
 * Ключи, записанные в БД до этой правки, остаются в старом формате — их
 * пересчитывает разовая миграция `npm run db:backfill:normalized` (contact/scripts).
 */
export function normalizePhone(
  phone?: string | null,
  countryCode = DEFAULT_PHONE_COUNTRY_CODE,
): string | undefined {
  const cc = (countryCode ?? '').replace(/\D/g, '') || DEFAULT_PHONE_COUNTRY_CODE;
  const raw = (phone ?? '').trim();
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return undefined;
  // Явно международная запись — уже E.164, только чистим разделители.
  if (raw.startsWith('+')) return `+${digits}`;
  // Междугородний/международный префикс РФ: 8XXXXXXXXXX или 7XXXXXXXXXX (11 цифр).
  if (digits.length === 11 && (digits.startsWith('8') || digits.startsWith('7'))) {
    return `+${cc}${digits.slice(1)}`;
  }
  // Национальный номер без префикса: 9123456789 (10 цифр).
  if (digits.length === 10) return `+${cc}${digits}`;
  return digits;
}
