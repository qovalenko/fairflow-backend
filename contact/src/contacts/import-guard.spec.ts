import {
  looksLikeBinaryImport,
  assertImportRowLimit,
  assertImportFileSize,
  assertImportProjectQuota,
  MAX_IMPORT_ROWS,
  MAX_IMPORT_FILE_BYTES,
  DEFAULT_PROJECT_CONTACT_QUOTA,
} from './import-guard';

describe('import-guard', () => {
  it('detects ZIP / xlsx signature', () => {
    expect(looksLikeBinaryImport(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true);
  });

  it('detects OLE signature', () => {
    expect(looksLikeBinaryImport(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00]))).toBe(true);
  });

  it('detects NUL bytes in the head', () => {
    expect(looksLikeBinaryImport(Buffer.from('a\0b', 'utf8'))).toBe(true);
  });

  it('allows plain UTF-8 CSV', () => {
    expect(looksLikeBinaryImport(Buffer.from('Имя,Фамилия\nИван,Иванов', 'utf8'))).toBe(false);
  });

  it('assertImportRowLimit rejects oversized batches with a client-facing AppError', () => {
    expect(() => assertImportRowLimit(MAX_IMPORT_ROWS + 1)).toThrow(/максимум/);
    // Именно AppError('invalid'): голый Error уехал бы клиенту как 500 Internal.
    let caught: unknown;
    try {
      assertImportRowLimit(MAX_IMPORT_ROWS + 1);
    } catch (e) {
      caught = e;
    }
    expect((caught as { errorCode?: string } | undefined)?.errorCode).toBe('invalid');
    expect(() => assertImportRowLimit(MAX_IMPORT_ROWS)).not.toThrow();
  });

  it('assertImportFileSize rejects oversized files', () => {
    expect(() => assertImportFileSize(MAX_IMPORT_FILE_BYTES + 1)).toThrow(/максимум/);
  });

  it('assertImportProjectQuota rejects when live + import exceed project cap', () => {
    expect(() => assertImportProjectQuota(99_990, 10, 100_000)).not.toThrow();
    expect(() => assertImportProjectQuota(99_995, 6, 100_000)).toThrow(/квота/);
    let caught: unknown;
    try {
      assertImportProjectQuota(DEFAULT_PROJECT_CONTACT_QUOTA, 1, DEFAULT_PROJECT_CONTACT_QUOTA);
    } catch (e) {
      caught = e;
    }
    expect((caught as { errorCode?: string } | undefined)?.errorCode).toBe('rateLimit');
  });
});
