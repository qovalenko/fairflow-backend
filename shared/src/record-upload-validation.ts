/** Max finished-document upload size (matches gateway multipart cap, FR-MDOC-21). */
export const MAX_RECORD_DOCUMENT_BYTES = 20 * 1024 * 1024;

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.ms-excel',
  'image/png',
  'image/jpeg',
  'image/gif',
]);

export type RecordUploadValidationError = 'FILE_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE';

/** Detect MIME from magic bytes — never trust the client Content-Type alone. */
export function detectRecordUploadMime(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('ascii').startsWith('GIF8')) return 'image/gif';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('binary');
    if (head.includes('word/')) {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    if (head.includes('xl/')) {
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    return null;
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0
  ) {
    const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('binary');
    if (head.includes('WordDocument')) return 'application/msword';
    if (head.includes('Workbook')) return 'application/vnd.ms-excel';
    return null;
  }
  return null;
}

export function validateRecordUploadBuffer(
  buffer: Buffer,
): { ok: true; mimeType: string } | { ok: false; code: RecordUploadValidationError } {
  if (buffer.length > MAX_RECORD_DOCUMENT_BYTES) {
    return { ok: false, code: 'FILE_TOO_LARGE' };
  }
  const mimeType = detectRecordUploadMime(buffer);
  if (!mimeType || !ALLOWED_MIMES.has(mimeType)) {
    return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' };
  }
  return { ok: true, mimeType };
}
