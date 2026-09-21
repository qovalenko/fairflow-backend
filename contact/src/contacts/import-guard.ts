import { AppError } from '@fairflow/shared';

/**
 * TODO-171: reject binary uploads masquerading as CSV (xlsx/zip/OLE) before parseCsv
 * turns them into garbage skipped rows.
 */
export function looksLikeBinaryImport(content: Buffer | undefined | null): boolean {
  if (!content || content.length === 0) return false;
  const head = content.subarray(0, Math.min(content.length, 512));
  // ZIP / OOXML (.xlsx is a zip) and classic OLE (.xls)
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07) &&
    (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08)
  ) {
    return true;
  }
  if (
    head.length >= 4 &&
    head[0] === 0xd0 &&
    head[1] === 0xcf &&
    head[2] === 0x11 &&
    head[3] === 0xe0
  ) {
    return true;
  }
  // NUL bytes are invalid in UTF-8 text CSV
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return true;
  }
  return false;
}

/** FR-CONTACTS-380 / TODO-375: cap import batch size (header row excluded). */
export const MAX_IMPORT_ROWS = 10_000;

/** Максимальный размер файла импорта в gRPC `bytes` (5 MiB). */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

/**
 * BOX: per-project cap on live contacts (no billing integration). Override via
 * `CONTACT_PROJECT_CONTACT_QUOTA` for large on-prem installs.
 */
export const DEFAULT_PROJECT_CONTACT_QUOTA = Number(
  process.env.CONTACT_PROJECT_CONTACT_QUOTA ?? 100_000,
);

export function assertImportFileSize(byteLength: number): void {
  if (byteLength > MAX_IMPORT_FILE_BYTES) {
    throw new AppError(
      'invalid',
      `Слишком большой файл импорта (${byteLength} байт): максимум ${MAX_IMPORT_FILE_BYTES} байт`,
    );
  }
}

export function assertImportRowLimit(dataRowCount: number): void {
  if (dataRowCount > MAX_IMPORT_ROWS) {
    // AppError, не Error: RpcAppExceptionFilter маппит голый Error в
    // INTERNAL → gateway 500 «Internal error», и русский текст лимита
    // до пользователя не доезжал бы.
    throw new AppError(
      'invalid',
      `Слишком много строк в файле (${dataRowCount}): максимум ${MAX_IMPORT_ROWS} за один импорт`,
    );
  }
}

/**
 * FR-CONTACTS-380 / TODO-375: project quota — live contacts + import rows must
 * fit under the per-project cap. Surfaces as 429 RESOURCE_EXHAUSTED on gateway.
 */
export function assertImportProjectQuota(
  liveContactCount: number,
  importRowCount: number,
  projectQuota = DEFAULT_PROJECT_CONTACT_QUOTA,
): void {
  const projected = liveContactCount + importRowCount;
  if (projected > projectQuota) {
    throw new AppError(
      'rateLimit',
      `Превышена квота контактов проекта: сейчас ${liveContactCount}, импорт ${importRowCount}, лимит ${projectQuota}`,
      { liveContactCount, importRowCount, projectQuota },
    );
  }
}
