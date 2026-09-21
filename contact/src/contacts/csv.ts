/**
 * TODO-164: настоящий разбор CSV вместо `line.split(/[,;]/)`.
 *
 * Импорт резал строку одновременно по запятой И по точке-с-запятой и ничего не знал
 * про кавычки, поэтому строка
 *
 *   "Иванов, Иван";+79001234567;a@b.ru
 *
 * разъезжалась: имя рвалось на две колонки, а телефон и почта уезжали на позицию
 * вправо — контакт создавался с мусором в полях и молча.
 *
 * Здесь компактный RFC 4180: кавычки, удвоенная кавычка внутри поля (`""`), перевод
 * строки внутри поля, CRLF/LF, BOM, автоопределение разделителя. Внешней зависимости
 * (csv-parse) в общем node_modules нет, а ставить пакеты в worktree нельзя.
 */

/** Разделители-кандидаты в порядке предпочтения при равном счёте. */
const CANDIDATES = [',', ';', '\t'] as const;
export type CsvDelimiter = (typeof CANDIDATES)[number];

/**
 * Разделитель определяем по ПЕРВОЙ ЛОГИЧЕСКОЙ СТРОКЕ и только вне кавычек:
 * иначе `"Иванов, Иван";…` выглядит как файл с запятыми.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(CANDIDATES.map((c) => [c, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    if (!inQuotes) {
      const c = counts.get(ch as CsvDelimiter);
      if (c !== undefined) counts.set(ch as CsvDelimiter, c + 1);
    }
  }
  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const c of CANDIDATES) {
    const n = counts.get(c) ?? 0;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Разбор CSV в матрицу ячеек. Полностью пустые строки отбрасываются (хвостовой
 * перевод строки не даёт фантомной записи), значения обрезаются по краям —
 * кроме случая, когда поле было в кавычках: там пробелы значимы.
 */
export function parseCsv(text: string, delimiter?: CsvDelimiter): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM из Excel
  const sep = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoted = false; // поле было закавычено → не триммим

  const pushField = () => {
    row.push(quoted ? field : field.trim());
    field = '';
    quoted = false;
  };
  const pushRow = () => {
    pushField();
    if (row.some((c) => c !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      quoted = true;
      continue;
    }
    if (ch === sep) {
      pushField();
      continue;
    }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      pushRow();
      continue;
    }
    if (ch === '\n') {
      pushRow();
      continue;
    }
    field += ch;
  }
  // Последняя строка без завершающего перевода строки.
  if (field !== '' || quoted || row.length) pushRow();
  return rows;
}
