import { BadRequestException } from '@nestjs/common';

/**
 * FR-COMPANIES-440 / FR-CONTACTS-360: привести карту колонок импорта к ориентации,
 * которую ждёт домен — `{ "<индекс колонки>": "<поле системы>" }`.
 *
 * Мастер импорта на фронте собирает её наоборот: `{ "<поле>": "<индекс>" }`
 * (Select «какая колонка соответствует полю»). Домен делает `Number(ключ)`, для
 * «name»/«firstName» получает NaN, колонку не берёт — и КАЖДАЯ строка падает.
 * Разворачиваем пары, у которых числовое значение, а ключ — нет; уже корректную
 * (числовой ключ) карту пропускаем как есть, чтобы не сломать API-клиентов.
 * Пустые значения (очищенный Select) отбрасываем.
 *
 * Нераспарсиваемый JSON отдаём домену без изменений — он сам вернёт понятную
 * ошибку `invalid mappingJson`.
 *
 * Целевые поля проходят allowlist: домен пишет размеченные колонки в документ
 * как есть, поэтому карта вида `{"createdBy":"0"}` подделала бы атрибуцию аудита,
 * а `{"departmentId":"1"}` — привязку к отделу, которая участвует в ABAC-фильтрации.
 * Неизвестное поле — 400, а не тихое отбрасывание: пользователь должен видеть, что
 * колонка не будет загружена.
 *
 * Единственная копия хелпера: v1-data-bff (компании) и crm-bff (контакты) зовут
 * именно её, чтобы allowlist-проверка и текст ошибки не разъехались.
 */
export const IMPORT_MAPPABLE_COMPANY_FIELDS = new Set([
  'name',
  'inn',
  'kpp',
  'ogrn',
  'legalAddress',
  'phone',
  'email',
  'website',
  'industry',
  'region',
  'notes',
  'tags',
]);

/**
 * Контакты: только бизнес-поля карточки. `ownerId`/`assigneeId`/`createdBy`/
 * `departmentId`/`projectId`/`id` НЕ мапятся из файла — владельца импортированных
 * записей проставляет домен (импортирующий пользователь), иначе загруженный файл
 * подделывал бы ABAC-принадлежность.
 *
 * Набор обязан ПОСИМВОЛЬНО совпадать с доменным `IMPORTABLE_CONTACT_FIELDS`
 * (`contact/src/contacts/import-mapping.ts`): шлюз проверяет первым, домен —
 * последним, и поле, разрешённое только здесь, превращается в приманку — мастер
 * даёт его замапить, шлюз пропускает, а домен роняет ВЕСЬ файл в 400.
 * Ровно так вело себя `companyName`: у контакта нет такого поля (связь с
 * компанией — `companyIds`, имя резолвится по справочнику), домен его не знал,
 * и импорт с колонкой «companyName» падал целиком. Добавлять сюда поле можно
 * только вместе с доменным allowlist и записью в документ.
 */
export const IMPORT_MAPPABLE_CONTACT_FIELDS = new Set([
  'firstName',
  'lastName',
  'middleName',
  'phone',
  'email',
  'position',
  'source',
  'notes',
  'tags',
]);

export function normalizeImportMapping(mappingJson: string, allowed: Set<string>): string {
  if (!mappingJson.trim()) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(mappingJson);
  } catch {
    return mappingJson;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return mappingJson;
  const isIndex = (v: string) => v.trim() !== '' && !Number.isNaN(Number(v));
  const assertAllowed = (field: string) => {
    if (!allowed.has(field)) {
      throw new BadRequestException(`поле «${field}» нельзя заполнять из файла импорта`);
    }
  };
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const v = raw == null ? '' : String(raw);
    if (v.trim() === '') continue;
    if (isIndex(k)) {
      assertAllowed(v);
      out[k] = v;
    } else if (isIndex(v)) {
      assertAllowed(k);
      out[v] = k;
    }
  }
  return JSON.stringify(out);
}
