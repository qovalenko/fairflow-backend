/**
 * FR-CONTACTS-360: разметка колонок файла импорта на стороне домена.
 *
 * Мастер импорта на фронте даёт карту «поле → колонка»; gateway разворачивает её в
 * `{ "<индекс колонки>": "<поле>" }` и прогоняет через свой allowlist. Домен обязан
 * (а) эту карту читать — иначе экран разметки колонок декоративен, файл всё равно
 * разбирается по фиксированным позициям, и (б) НЕ доверять ей слепо: allowlist
 * повторяется здесь, потому что домен — последняя точка перед записью, а карта вида
 * `{"0":"ownerId"}` подделала бы владельца (то есть ABAC-принадлежность записи).
 */
import { AppError } from '@fairflow/shared';

/**
 * Поля, которые можно заполнить из файла. Копия allowlist gateway (сознательная:
 * домен обязан отказать сам, даже если его позовут не через gateway).
 * `ownerId/assigneeId/createdBy/departmentId/projectId/id` не мапятся никогда.
 */
export const IMPORTABLE_CONTACT_FIELDS = new Set([
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

/** Карта «индекс колонки → поле контакта». */
export type ImportMapping = Record<number, string>;

/** Прежнее поведение импорта — позиционные колонки без заголовка. */
const POSITIONAL_FALLBACK: ImportMapping = {
  0: 'firstName',
  1: 'lastName',
  2: 'phone',
  3: 'email',
};

/** Синонимы заголовков (ru/en, регистр и пробелы не важны). */
const HEADER_SYNONYMS: Record<string, string> = {
  имя: 'firstName',
  firstname: 'firstName',
  'first name': 'firstName',
  фамилия: 'lastName',
  lastname: 'lastName',
  'last name': 'lastName',
  surname: 'lastName',
  отчество: 'middleName',
  middlename: 'middleName',
  'middle name': 'middleName',
  телефон: 'phone',
  тел: 'phone',
  phone: 'phone',
  mobile: 'phone',
  email: 'email',
  'e-mail': 'email',
  почта: 'email',
  'эл. почта': 'email',
  должность: 'position',
  position: 'position',
  источник: 'source',
  source: 'source',
  заметки: 'notes',
  комментарий: 'notes',
  notes: 'notes',
  comment: 'notes',
  теги: 'tags',
  метки: 'tags',
  tags: 'tags',
};

/** Разбор карты колонок из `mapping_json`. Пустая строка → карты нет. */
export function parseImportMapping(mappingJson?: string): ImportMapping | null {
  const raw = (mappingJson ?? '').trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError('invalid', 'Некорректная карта колонок импорта', {
      field: 'mappingJson',
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('invalid', 'Некорректная карта колонок импорта', {
      field: 'mappingJson',
    });
  }
  const out: ImportMapping = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const idx = Number(k);
    const field = String(v ?? '').trim();
    if (!Number.isInteger(idx) || idx < 0 || !field) continue;
    if (!IMPORTABLE_CONTACT_FIELDS.has(field)) {
      // Молча отбрасывать нельзя: пользователь должен узнать, что колонка не
      // загрузится (а попытка подменить владельца — это отказ, а не «ой»).
      throw new AppError('invalid', `Поле «${field}» нельзя заполнять из файла импорта`, {
        field: 'mappingJson',
      });
    }
    out[idx] = field;
  }
  return Object.keys(out).length ? out : null;
}

/** Карта по строке заголовка: «Фамилия;Имя;Телефон» → {0:lastName,1:firstName,…}. */
export function mappingFromHeader(header: string[]): ImportMapping | null {
  const out: ImportMapping = {};
  header.forEach((cell, idx) => {
    const key = (cell ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const field = HEADER_SYNONYMS[key];
    if (field && !Object.values(out).includes(field)) out[idx] = field;
  });
  return Object.keys(out).length ? out : null;
}

/** Итоговая карта: явная > по заголовку > позиционный фолбэк. */
export function resolveImportMapping(
  mappingJson: string | undefined,
  header: string[],
): ImportMapping {
  return parseImportMapping(mappingJson) ?? mappingFromHeader(header) ?? POSITIONAL_FALLBACK;
}

/** Значения одной строки файла, разложенные по полям контакта. */
export interface ImportRowValues {
  firstName: string;
  lastName: string;
  middleName: string;
  phone: string;
  email: string;
  position: string;
  source: string;
  notes: string;
  tags?: string[];
}

export function applyImportMapping(mapping: ImportMapping, row: string[]): ImportRowValues {
  const values: ImportRowValues = {
    firstName: '',
    lastName: '',
    middleName: '',
    phone: '',
    email: '',
    position: '',
    source: '',
    notes: '',
  };
  for (const [idxRaw, field] of Object.entries(mapping)) {
    const cell = (row[Number(idxRaw)] ?? '').trim();
    if (!cell) continue;
    if (field === 'tags') {
      const tags = cell
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (tags.length) values.tags = tags;
      continue;
    }
    (values as unknown as Record<string, string>)[field] = cell;
  }
  return values;
}
