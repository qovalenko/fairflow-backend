/**
 * CSV reader for the company import (TODO-361 / FR-COMPANIES-440), RFC 4180.
 *
 * Why this is a separate module and not three lines of `String.split`: the wizard
 * builds the column map from ITS OWN parse of the same file, and the domain then
 * cuts the very same file to find the mapped column indexes. A naive
 * `line.split(/[,;\t]/)` disagrees with the file itself as soon as the data is
 * real: `ООО «Ромашка, Инк»` becomes two cells and silently shifts every later
 * column of that row into the wrong field (INN lands in KPP, e-mail in industry),
 * a newline inside a quoted address breaks one company into two broken rows, and
 * `""` stays doubled inside the value.
 *
 * The mirror of this file lives in the frontend
 * (`frontend/modules/companies/src/views/crm/Import/csv.ts`). The two must stay
 * byte-identical in behaviour — delimiter detection, quoting rules and header
 * recognition — otherwise the preview the user maps columns on and the rows the
 * domain writes drift apart by a column. Change one → change the other.
 */

const BOM = '\uFEFF';

/** Delimiters we auto-detect. `|` is deliberately absent: it separates tags INSIDE a cell. */
export const CSV_DELIMITERS = [',', ';', '\t'] as const;

/** One parsed record plus the 1-based physical line it starts on (for row errors). */
export type CsvRecord = { cells: string[]; line: number };

/**
 * Delimiter of the file = the candidate that occurs most often in the FIRST record,
 * counted outside quotes (so `"Рога, копыта";7701` is a semicolon file, not a comma one).
 * No candidate present (single-column file) → `,`, which yields the same single cell.
 */
export function detectCsvDelimiter(text: string): string {
  const counts = new Map<string, number>(CSV_DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') break; // first record is enough
    const seen = counts.get(ch);
    if (seen !== undefined) counts.set(ch, seen + 1);
  }
  let best = ',';
  let bestCount = 0;
  for (const d of CSV_DELIMITERS) {
    const c = counts.get(d) ?? 0;
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

/**
 * RFC 4180 parse: quoted fields keep delimiters and newlines, `""` unescapes to `"`,
 * unquoted fields are trimmed (files exported by Excel/1С pad with spaces), blank
 * lines are dropped. Lenient on the two malformations real exports produce: an
 * unterminated final quote (treated as end of field) and stray quotes inside an
 * unquoted field (kept literally) — an import must not die on one bad character.
 */
export function parseCsv(text: string, delimiter: string = detectCsvDelimiter(text)): CsvRecord[] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let fieldQuoted = false;
  let recordQuoted = false;
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let recordStarted = false;

  const startRecord = () => {
    if (!recordStarted) {
      recordStarted = true;
      recordLine = line;
    }
  };
  const endField = () => {
    cells.push(fieldQuoted ? field : field.trim());
    field = '';
    fieldQuoted = false;
  };
  const endRecord = () => {
    endField();
    // A blank line carries no record; `""` on its own is an explicit empty cell and stays.
    if (!(cells.length === 1 && cells[0] === '' && !recordQuoted)) {
      records.push({ cells, line: recordLine });
    }
    cells = [];
    recordQuoted = false;
    recordStarted = false;
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
        continue;
      }
      // Newline inside a quoted field belongs to the value; normalise CRLF → LF.
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        field += '\n';
        line++;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') {
      startRecord();
      if (field === '' && !fieldQuoted) {
        inQuotes = true;
        fieldQuoted = true;
        recordQuoted = true;
      } else {
        field += ch; // stray quote mid-field: keep it, do not reinterpret the row
      }
      continue;
    }
    if (ch === delimiter) {
      startRecord();
      endField();
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      if (recordStarted || field !== '' || cells.length) endRecord();
      line++;
      continue;
    }
    startRecord();
    field += ch;
  }
  if (recordStarted || field !== '' || cells.length) endRecord();
  return records;
}

/** Fold a header cell to a comparable token: case, spaces, `_`/`-` and BOM are noise. */
export function normalizeHeaderToken(cell: string): string {
  return cell
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * Header vocabulary for company files: the mappable field names themselves plus the
 * Russian captions Excel/1С exports carry. Mirrored verbatim on the frontend.
 */
export const COMPANY_HEADER_TOKENS: ReadonlySet<string> = new Set([
  // field names (company.md §3.17)
  'name',
  'inn',
  'kpp',
  'ogrn',
  'legaladdress',
  'phone',
  'email',
  'website',
  'industry',
  'region',
  'notes',
  'tags',
  // russian captions
  'название',
  'наименование',
  'компания',
  'организация',
  'инн',
  'кпп',
  'огрн',
  'юридическийадрес',
  'юрадрес',
  'адрес',
  'телефон',
  'тел',
  'почта',
  'эл.почта',
  'электроннаяпочта',
  'сайт',
  'вебсайт',
  'отрасль',
  'сфера',
  'регион',
  'заметки',
  'примечание',
  'примечания',
  'комментарий',
  'теги',
  'метки',
]);

/**
 * Is the first record a header? Answered by content, not by position — a file exported
 * without captions used to lose its first company, because the importer skipped record
 * index 0 unconditionally. One recognised caption is enough (mixed/partial headers are
 * the norm); a data row hits none of the tokens, since they are field captions.
 */
export function looksLikeHeaderRow(
  cells: readonly string[],
  tokens: ReadonlySet<string> = COMPANY_HEADER_TOKENS,
): boolean {
  return cells.some((c) => tokens.has(normalizeHeaderToken(c)));
}
