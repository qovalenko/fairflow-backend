import { validateRecordUploadBuffer } from './record-upload-validation';

describe('validateRecordUploadBuffer (FR-DOCS-162)', () => {
  it('accepts a PDF by magic bytes', () => {
    const buf = Buffer.from('%PDF-1.4\n');
    expect(validateRecordUploadBuffer(buf)).toEqual({
      ok: true,
      mimeType: 'application/pdf',
    });
  });

  it('rejects unknown binary as UNSUPPORTED_MEDIA_TYPE', () => {
    const buf = Buffer.from([0, 1, 2, 3, 4, 5]);
    expect(validateRecordUploadBuffer(buf)).toEqual({
      ok: false,
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });

  it('rejects oversize buffers as FILE_TOO_LARGE', () => {
    const buf = Buffer.alloc(20 * 1024 * 1024 + 1, 0x25);
    buf.write('%PDF', 0);
    expect(validateRecordUploadBuffer(buf)).toEqual({
      ok: false,
      code: 'FILE_TOO_LARGE',
    });
  });
});
