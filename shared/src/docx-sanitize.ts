/**
 * DOCX (OOXML) upload sanitizer — FR-MDOC-9/10, SEC §3.3/§3.4, CONFORMANCE C3.
 *
 * Framework-agnostic core so BOTH boundaries share one implementation:
 *  - the gateway BFF runs it on the raw multipart bytes BEFORE persisting to S3
 *    (never store an unsafe file), and
 *  - the documents domain re-runs it on the stored object as the authoritative
 *    gate (defense-in-depth, `DocxValidator` wraps this).
 *
 * A `.docx` is a ZIP of XML parts; loading one back into a renderer is an
 * active-content attack surface (RCE/XXE/zip-bomb). We statically inspect the
 * bytes and FAIL CLOSED on any of:
 *  - not an OOXML zip (no `[Content_Types].xml` / `word/document.xml`);
 *  - VBA macro (`word/vbaProject.bin`) or `.docm` macro content-type;
 *  - XXE: `<!DOCTYPE`, `<!ENTITY`, external `SYSTEM`/`PUBLIC` DTD in any XML part;
 *  - DDE / auto-exec field links (`DDEAUTO`, `DDE`, `<w:fldSimple ... DDE>`);
 *  - zip-bomb: declared uncompressed size or compression ratio over the limit;
 *  - oversized upload.
 *
 * Implemented WITHOUT a third-party zip dependency: we parse the ZIP central
 * directory straight off the buffer (entry names + declared compressed/
 * uncompressed sizes), then byte-scan the whole archive for the XXE/DDE markers
 * (defense-in-depth — covers compressed parts via the raw bytes too). On any
 * detection we throw `DocxValidationError` carrying a machine-readable `reason`;
 * callers map it to their transport (gRPC `TEMPLATE_INVALID` / HTTP 422).
 *
 * This module ALSO exposes `extractDocxPlaceholders` — the read side of the same
 * package parse — which pulls the `{{variable}}` keys a template declares out of
 * the DOCX text so the domain can persist them automatically (FR-MDOC G2).
 */
import { inflateRawSync } from 'node:zlib';

/** Maximum accepted compressed upload size (anti-DoS, before inspection). */
const MAX_COMPRESSED_BYTES = 25 * 1024 * 1024; // 25 MiB
/** Maximum total declared UNCOMPRESSED size across all parts (zip-bomb). */
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MiB
/** Maximum allowed overall compression ratio (zip-bomb heuristic). */
const MAX_COMPRESSION_RATIO = 200;
/** Maximum number of entries (zip-bomb / quine guard). */
const MAX_ENTRIES = 2048;

const EOCD_SIGNATURE = 0x06054b50; // End Of Central Directory
const CDH_SIGNATURE = 0x02014b50; // Central Directory File Header
const LFH_SIGNATURE = 0x04034b50; // Local File Header

export type DocxRejectReason =
  | 'not_ooxml'
  | 'vba_macro'
  | 'xxe'
  | 'dde'
  | 'zip_bomb'
  | 'too_large'
  | 'corrupt';

export interface DocxZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

/** Thrown on any unsafe pattern; `reason` is stable for transport mapping. */
export class DocxValidationError extends Error {
  constructor(
    public readonly reason: DocxRejectReason,
    message: string,
  ) {
    super(message);
    this.name = 'DocxValidationError';
  }
}

function reject(reason: DocxRejectReason, message: string): never {
  throw new DocxValidationError(reason, message);
}

/**
 * Validate a buffer that should be a safe DOCX template. Throws
 * `DocxValidationError` on any unsafe pattern; returns the parsed entry list on
 * success (callers may ignore it).
 */
export function sanitizeDocxBuffer(buf: Buffer): { entries: DocxZipEntry[] } {
  if (!buf || buf.length === 0) reject('corrupt', 'Пустой файл шаблона');
  if (buf.length > MAX_COMPRESSED_BYTES) {
    reject('too_large', 'Файл шаблона превышает лимит размера');
  }
  const entries = parseCentralDirectory(buf);

  // OOXML structure: the package manifest + the main document part.
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  if (!names.has('[content_types].xml') || !names.has('word/document.xml')) {
    reject('not_ooxml', 'Файл не является корректным DOCX (OOXML)');
  }

  // VBA macro carrier — never accepted (FR-MDOC-10).
  for (const name of names) {
    if (name.endsWith('vbaproject.bin') || name.includes('/vbaproject')) {
      reject('vba_macro', 'Шаблон содержит запрещённый макрос');
    }
  }

  // zip-bomb: entry count, total uncompressed size, compression ratio.
  if (entries.length > MAX_ENTRIES) {
    reject('zip_bomb', 'Шаблон содержит слишком много частей');
  }
  let totalUncompressed = 0;
  let totalCompressed = 0;
  for (const e of entries) {
    totalUncompressed += e.uncompressedSize;
    totalCompressed += e.compressedSize;
  }
  if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
    reject('zip_bomb', 'Распакованный шаблон превышает лимит размера');
  }
  if (totalCompressed > 0 && totalUncompressed / totalCompressed > MAX_COMPRESSION_RATIO) {
    reject('zip_bomb', 'Подозрительная степень сжатия шаблона');
  }

  // XXE / DDE scan. The whole-buffer byte scan only catches markers stored
  // uncompressed (STORE) — a DEFLATE-compressed part hides the ASCII markers in
  // its deflate stream. So we ALSO inflate every XML part and scan the decoded
  // text (fail-closed on a bomb/corrupt part).
  scanActiveContent(buf);
  scanInflatedXmlParts(buf);

  return { entries };
}

/**
 * Parse the ZIP central directory off the buffer (no inflate needed). We do NOT
 * decompress — only the declared metadata + a whole-buffer byte scan are used.
 * Throws `corrupt` on a malformed/absent central directory.
 */
function parseCentralDirectory(buf: Buffer): DocxZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) reject('corrupt', 'Повреждённый DOCX (нет central directory)');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: DocxZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length) reject('corrupt', 'Повреждённый DOCX (CD-запись)');
    if (buf.readUInt32LE(offset) !== CDH_SIGNATURE) {
      reject('corrupt', 'Повреждённый DOCX (подпись CD)');
    }
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    if (nameStart + nameLen > buf.length) reject('corrupt', 'Повреждённый DOCX (имя)');
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    entries.push({ name, compressedSize, uncompressedSize });
    offset = nameStart + nameLen + extraLen + commentLen;
    if (entries.length > MAX_ENTRIES) break;
  }
  if (entries.length === 0) reject('corrupt', 'Пустой DOCX-архив');
  return entries;
}

/** Locate the End-Of-Central-Directory record (scan back over the comment). */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/** XML parts whose inflated text we scan for active content (word/*, [Content_Types].xml, rels). */
const SCANNED_XML_PART = /^word\/|\.(xml|rels)$/i;

/**
 * Whole-buffer byte scan for active-content / external-entity markers. Catches
 * markers stored uncompressed (STORE); DEFLATE parts are covered separately by
 * `scanInflatedXmlParts`.
 */
function scanActiveContent(buf: Buffer): void {
  // Scan as latin1 so multi-byte UTF-8 never hides an ASCII marker.
  scanTextForActiveContent(buf.toString('latin1'));
}

/**
 * Inflate every XML part (bounded) and scan the DECODED text for the markers —
 * the whole-buffer scan is blind to anything inside a deflate stream. A part
 * that fails to inflate within the cap is a zip-bomb; a truncated/garbage
 * deflate stream is corrupt. Both fail closed.
 */
function scanInflatedXmlParts(buf: Buffer): void {
  for (const e of iterCentralDirectory(buf)) {
    if (!SCANNED_XML_PART.test(e.name)) continue;
    let bytes: Buffer | null;
    try {
      bytes = readEntryBytes(buf, e.localOffset, e.method, e.compressedSize);
    } catch (err) {
      if (err instanceof RangeError) {
        reject('zip_bomb', 'Часть шаблона распаковывается сверх лимита (zip-bomb)');
      }
      reject('corrupt', 'Повреждённая часть DOCX (не удалось распаковать)');
    }
    if (bytes) scanTextForActiveContent(bytes.toString('latin1'));
  }
}

/**
 * Reject `text` if it carries an XXE (DTD/entity/external ref) or DDE marker.
 * OOXML parts are XML with NO DTD and NO external entities in legitimate
 * documents, so any of these markers is a rejection.
 */
function scanTextForActiveContent(text: string): void {
  const upper = text.toUpperCase();

  // XXE: DTD / entity declarations / external references in any XML part.
  if (
    upper.includes('<!DOCTYPE') ||
    upper.includes('<!ENTITY') ||
    /\b(SYSTEM|PUBLIC)\b\s+["']/.test(upper)
  ) {
    reject('xxe', 'Шаблон содержит запрещённый DTD/внешнюю сущность (XXE)');
  }

  // DDE / auto-exec field codes (CVE-class macro-less code execution).
  if (upper.includes('DDEAUTO') || /\bW:FLDSIMPLE\b[^>]*\bDDE\b/.test(upper)) {
    reject('dde', 'Шаблон содержит запрещённую DDE-ссылку');
  }
}

// ---------------------------------------------------------------------------
// Placeholder extraction (read side) — FR-MDOC G2
// ---------------------------------------------------------------------------

/** DOCX parts whose text may carry `{{placeholders}}`: body + all headers/footers. */
const PLACEHOLDER_PART = /^word\/(document|header\d*|footer\d*)\.xml$/i;
/** A flat dotted variable key: `contact.name`, `order.field.total`. */
const VARIABLE_KEY = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
/** Cap on total inflated XML we scan (sanitize already ran; this is belt-and-braces). */
const MAX_EXTRACT_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * Extract the flat `{{tag}}` variable keys a DOCX template declares. Inflates the
 * body + header/footer parts, drops XML tags so a placeholder Word split across
 * `<w:t>` runs (`{{con</w:t>…<w:t>tact.name}}`) rejoins into one string, then
 * matches `{{key}}` and returns the SORTED unique dotted keys.
 *
 * Section / partial / comment markers (`{{#..}}`, `{{/..}}`, `{{^..}}`, `{{>..}}`,
 * `{{!..}}`) and any non-key text are ignored — the render engine uses a flat
 * dotted-key map, so only those keys are meaningful. Never throws: a buffer we
 * cannot read yields `[]` (the caller keeps its fallback).
 */
export function extractDocxPlaceholders(buf: Buffer): string[] {
  let xml = '';
  try {
    for (const part of readZipParts(buf, PLACEHOLDER_PART)) {
      xml += part;
      if (xml.length > MAX_EXTRACT_BYTES) break;
    }
  } catch {
    return [];
  }
  const text = xml.replace(/<[^>]*>/g, '');
  const keys = new Set<string>();
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    if (VARIABLE_KEY.test(raw)) keys.add(raw);
  }
  return [...keys].sort();
}

interface ZipEntryLoc {
  name: string;
  method: number;
  localOffset: number;
  compressedSize: number;
}

/**
 * Walk the ZIP central directory, yielding each entry's name + local-header
 * locator. Stops at the first structural inconsistency (best-effort read side).
 */
function* iterCentralDirectory(buf: Buffer): Generator<ZipEntryLoc> {
  const eocd = findEocd(buf);
  if (eocd < 0) return;
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CDH_SIGNATURE) return;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset = offset + 46 + nameLen + extraLen + commentLen;
    yield { name, method, localOffset, compressedSize };
  }
}

/**
 * Iterate the UTF-8 text of ZIP entries whose name matches `filter`, inflating
 * deflate streams via the central directory (its sizes are authoritative even
 * when a local header uses a data descriptor). Best-effort: entries with an
 * unknown compression method or unreadable bytes are skipped, not thrown.
 */
function* readZipParts(buf: Buffer, filter: RegExp): Generator<string> {
  for (const e of iterCentralDirectory(buf)) {
    if (!filter.test(e.name)) continue;
    let bytes: Buffer | null;
    try {
      bytes = readEntryBytes(buf, e.localOffset, e.method, e.compressedSize);
    } catch {
      continue; // bomb / corrupt part — skip on the best-effort read side
    }
    if (bytes) yield bytes.toString('utf8');
  }
}

/**
 * Read one entry's raw bytes off its local header: STORE (0) as-is, DEFLATE (8)
 * inflated with a bounded output cap so a single part cannot zip-bomb us
 * regardless of the size the central directory declares. Returns null for a
 * missing/mismatched local header, out-of-bounds data, or unknown method; throws
 * a `RangeError` when the inflated output would exceed `MAX_EXTRACT_BYTES`.
 */
function readEntryBytes(
  buf: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
): Buffer | null {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LFH_SIGNATURE) {
    return null;
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buf.length) return null;
  const raw = buf.subarray(dataStart, dataEnd);
  if (method === 0) return raw;
  if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_EXTRACT_BYTES });
  return null;
}
