/**
 * Планировщик разовой миграции дедуп-ключей контактов (`phoneNormalized`,
 * `emailNormalized`).
 *
 * ЗАЧЕМ. `normalizePhone` сменила формат ключа на E.164 (`+7…`), но записи,
 * созданные раньше, хранят ключ в старом формате (`89123456789`, `79123456789`).
 * Пока они не пересчитаны:
 *  - партиал-уникальный индекс `uniq_project_phone_normalized` НЕ ловит пару
 *    «старая запись против новой» — ключи разные, конфликта для Mongo нет;
 *  - `findDuplicates` и очередь дублей (`buildDuplicateQueuePipeline`) сводят
 *    записи строго по равенству ключа, значит такую пару они тоже не видят.
 * То есть на существующих данных требование о дедупе не выполняется — это гейт
 * выкатки домена, а не примечание. Пересчёт выполняет
 * `contact/scripts/backfill-normalized-keys.ts`.
 *
 * ПОЧЕМУ ЧИСТАЯ ФУНКЦИЯ. Политика коллизий — единственное здесь, что можно
 * сделать неправильно, и она же единственное, что нельзя проверить глазами на
 * проде. Планирование отделено от записи, чтобы правила проверялись тестом без
 * живой Mongo, а скрипт остался тонким (курсор + bulkWrite + отчёт).
 *
 * ПОЛИТИКА КОЛЛИЗИЙ. Две живые записи, схлопывающиеся в один ключ, в уникальный
 * индекс не пройдут физически. Ключ остаётся у одной («победитель»), у остальных
 * ключ снимается ($unset) и пара уходит в отчёт о конфликтах:
 *  - запись НЕ удаляется и НЕ сливается автоматически — слияние необратимо-дорого
 *    и требует решения человека (в домене это `merge` с окном отката);
 *  - `$unset` (а не «оставить старый ключ») выбран сознательно: старый ключ уже
 *    недостижим новой нормализацией, он был бы мёртвым грузом в индексе и создавал
 *    ложное ощущение, что запись под дедупом;
 *  - это ровно та же развязка, что домен применяет при `restore` конфликтующей
 *    записи (стратегия `clear_keys`), — миграция не изобретает новое поведение.
 *
 * Победитель выбирается детерминированно, чтобы повторный запуск ничего не
 * переигрывал: (1) тот, у кого ключ уже равен новому, (2) самый ранний
 * `createdAt`, (3) наименьший `_id`.
 */

import { normalizeEmail, normalizePhone } from './normalize';

/** Поля-ключи, которые пересчитывает миграция. */
export const NORMALIZED_FIELDS = ['phoneNormalized', 'emailNormalized'] as const;
export type NormalizedField = (typeof NORMALIZED_FIELDS)[number];

/** Минимальная проекция документа, которой хватает планировщику. */
export interface BackfillDoc {
  id: string;
  projectId: string;
  phone?: string | null;
  email?: string | null;
  phoneNormalized?: string | null;
  emailNormalized?: string | null;
  createdAt?: Date | string | number | null;
}

/** Что записать в конкретный документ. Пустые патчи в план не попадают. */
export interface DocPatch {
  id: string;
  set: Partial<Record<NormalizedField, string>>;
  unset: NormalizedField[];
}

/** Группа живых записей, схлопнувшихся в один ключ. */
export interface KeyConflict {
  projectId: string;
  field: NormalizedField;
  key: string;
  /** Кому ключ оставлен (остаётся под уникальным индексом и дедуп-радаром). */
  keptId: string;
  /** У кого ключ снят — этих обязан развести человек (merge/правка). */
  droppedIds: string[];
}

export interface BackfillPlan {
  patches: DocPatch[];
  conflicts: KeyConflict[];
}

/** Источник значения для каждого ключевого поля. */
const SOURCE_FIELD: Record<NormalizedField, 'phone' | 'email'> = {
  phoneNormalized: 'phone',
  emailNormalized: 'email',
};

function normalizeFor(field: NormalizedField, doc: BackfillDoc): string | undefined {
  return field === 'phoneNormalized' ? normalizePhone(doc.phone) : normalizeEmail(doc.email);
}

function createdAtMs(doc: BackfillDoc): number {
  if (doc.createdAt == null) return Number.POSITIVE_INFINITY; // без даты — заведомо не победитель
  const t = new Date(doc.createdAt).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Порядок внутри группы: первый — победитель.
 * `alreadyMatching` первым критерием держит план стабильным при повторном запуске.
 */
function orderGroup(field: NormalizedField, key: string, docs: BackfillDoc[]): BackfillDoc[] {
  return [...docs].sort((a, b) => {
    const aKept = a[field] === key ? 0 : 1;
    const bKept = b[field] === key ? 0 : 1;
    if (aKept !== bKept) return aKept - bKept;
    const at = createdAtMs(a);
    const bt = createdAtMs(b);
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Считает план пересчёта для НАБОРА ЖИВЫХ записей (скрипт передаёт по одному
 * проекту за раз: удалённые и тени слияния сюда попадать не должны — у них ключи
 * сняты намеренно, чтобы не занимать уникальный индекс).
 */
export function planNormalizedKeyBackfill(docs: BackfillDoc[]): BackfillPlan {
  const patches = new Map<string, DocPatch>();
  const conflicts: KeyConflict[] = [];

  const patchFor = (id: string): DocPatch => {
    let p = patches.get(id);
    if (!p) {
      p = { id, set: {}, unset: [] };
      patches.set(id, p);
    }
    return p;
  };

  for (const field of NORMALIZED_FIELDS) {
    // key → документы проекта, дающие этот ключ. projectId в ключе группировки:
    // уникальность и дедуп — строго внутри проекта (граница x-project-id).
    const groups = new Map<string, { projectId: string; key: string; docs: BackfillDoc[] }>();

    for (const doc of docs) {
      const next = normalizeFor(field, doc);
      const current = doc[field] ?? undefined;
      if (!next) {
        // Значения нет (или оно пустое), а ключ в базе остался — снять, иначе
        // запись занимает слот в уникальном индексе по несуществующим данным.
        if (current) patchFor(doc.id).unset.push(field);
        continue;
      }
      const gk = `${doc.projectId}\u0000${next}`;
      const g = groups.get(gk) ?? { projectId: doc.projectId, key: next, docs: [] };
      g.docs.push(doc);
      groups.set(gk, g);
    }

    for (const g of groups.values()) {
      const [winner, ...losers] = orderGroup(field, g.key, g.docs);
      if ((winner[field] ?? undefined) !== g.key) patchFor(winner.id).set[field] = g.key;
      if (!losers.length) continue;
      for (const l of losers) {
        if (l[field] != null) patchFor(l.id).unset.push(field);
      }
      conflicts.push({
        projectId: g.projectId,
        field,
        key: g.key,
        keptId: winner.id,
        droppedIds: losers.map((l) => l.id),
      });
    }
  }

  return {
    patches: [...patches.values()].filter((p) => Object.keys(p.set).length || p.unset.length),
    conflicts,
  };
}

/** Человекочитаемое имя исходного поля — для отчёта скрипта. */
export function sourceFieldOf(field: NormalizedField): 'phone' | 'email' {
  return SOURCE_FIELD[field];
}
