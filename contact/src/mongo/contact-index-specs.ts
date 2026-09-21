/**
 * Спецификации индексов коллекции `contacts` — единственный источник правды.
 *
 * Отдельным модулем без зависимостей от Nest: их применяет и сервис при старте
 * (`MongoService.ensureContactIndexes`), и разовая миграция ключей
 * (`contact/scripts/backfill-normalized-keys.ts`), которая после пересчёта обязана
 * убедиться, что уникальные индексы действительно встали. Копия спецификаций в
 * скрипте разъехалась бы с доменом молча.
 */

export interface ContactIndexSpec {
  key: Record<string, 1 | -1>;
  opts: Record<string, unknown>;
}

/**
 * - `{ projectId, deletedAt, updatedAt }` backs the project-scoped `list`
 *   query (filter on projectId+deletedAt, sort updatedAt desc).
 * - Partial-unique `{ projectId, emailNormalized }` / `{ projectId,
 *   phoneNormalized }` enforce per-project dedup on the normalized keys
 *   (checkDuplicates). Partial on `$exists` only — Mongo rejects
 *   `deletedAt: null` in a partialFilterExpression ("Expression not supported
 *   in partial index"). Instead, soft-delete/merge $unset the normalized keys,
 *   so tombstoned rows drop out of the index and re-creating the same identity
 *   is not blocked while live rows stay unique.
 */
export const CONTACT_INDEX_SPECS: ContactIndexSpec[] = [
  {
    key: { projectId: 1, deletedAt: 1, updatedAt: -1 },
    opts: { name: 'project_deleted_updated' },
  },
  {
    key: { projectId: 1, emailNormalized: 1 },
    opts: {
      name: 'uniq_project_email_normalized',
      unique: true,
      partialFilterExpression: { emailNormalized: { $exists: true } },
    },
  },
  {
    key: { projectId: 1, phoneNormalized: 1 },
    opts: {
      name: 'uniq_project_phone_normalized',
      unique: true,
      partialFilterExpression: { phoneNormalized: { $exists: true } },
    },
  },
  // TODO-172: purgeAt считался (7д для корзины, 30д для merge-tombstone), но
  // ничто его не исполняло — ни TTL-индекса, ни планировщика: корзина и
  // «тени» слияний копились в проекте вечно. TTL с expireAfterSeconds:0
  // удаляет документ, когда наступает время в purgeAt; restore/unmerge
  // делают $unset purgeAt, поэтому оживлённые записи из индекса выпадают
  // (документ без поля даты TTL не трогает).
  {
    key: { purgeAt: 1 },
    opts: { name: 'ttl_purge_at', expireAfterSeconds: 0 },
  },
  // TODO-161: карточка контакта показывает поглощённые им тени слияний
  // (единственная точка входа в откат) — запрос идёт по { projectId,
  // mergedInto }. Без индекса это скан коллекции на каждое открытие карточки.
  {
    key: { projectId: 1, mergedInto: 1, mergedAt: -1 },
    opts: { name: 'project_merged_into' },
  },
  // FR-MCOM-18: reverse lookup contacts by companyIds (ListContacts filter).
  {
    key: { projectId: 1, companyIds: 1, deletedAt: 1, updatedAt: -1 },
    opts: { name: 'project_company_deleted_updated' },
  },
];

/**
 * Уникальные индексы дедупа. Именно они не встают, пока в проекте живут два
 * контакта с одинаковым нормализованным ключом, — поэтому миграция проверяет их
 * отдельно и падает, если создать не удалось.
 */
export const CONTACT_DEDUP_UNIQUE_INDEXES = CONTACT_INDEX_SPECS.filter(
  (s) => s.opts.unique === true,
);
