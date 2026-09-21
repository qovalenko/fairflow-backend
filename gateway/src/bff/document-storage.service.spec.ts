import { UnprocessableEntityException } from '@nestjs/common';
import { DocxValidationError } from '@fairflow/shared';
import { DocumentStorageService } from './document-storage.service';

const send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send })),
  HeadBucketCommand: jest.fn().mockImplementation((input) => ({ kind: 'head', ...input })),
  CreateBucketCommand: jest.fn().mockImplementation((input) => ({ kind: 'create', ...input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ kind: 'put', ...input })),
}));

jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return {
    ...actual,
    sanitizeDocxBuffer: jest.fn(),
    validateRecordUploadBuffer: jest.fn(),
  };
});

import { sanitizeDocxBuffer, validateRecordUploadBuffer } from '@fairflow/shared';

const mockedSanitize = jest.mocked(sanitizeDocxBuffer);
const mockedValidate = jest.mocked(validateRecordUploadBuffer);

describe('DocumentStorageService uploads', () => {
  const config = {
    s3Region: 'us-east-1',
    s3Endpoint: 'http://minio:9000',
    s3AccessKeyId: 'key',
    s3SecretAccessKey: 'secret',
    s3DocumentsBucket: 'fairflow-documents',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    send.mockImplementation(async (cmd: { kind?: string }) => {
      if (cmd.kind === 'head') throw new Error('missing bucket');
      return {};
    });
  });

  function make(): DocumentStorageService {
    return new DocumentStorageService(config as never);
  }

  it('uploadTemplateFile rejects unsafe DOCX before touching S3', async () => {
    mockedSanitize.mockImplementation(() => {
      throw new DocxValidationError('vba_macro', 'VBA detected');
    });
    const svc = make();

    await expect(
      svc.uploadTemplateFile({ projectId: 'p-1', fileName: 'tpl.docx', buffer: Buffer.from('x') }),
    ).rejects.toMatchObject({
      response: { code: 'TEMPLATE_INVALID', reason: 'vba_macro' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('uploadTemplateFile stores sanitized DOCX under the project prefix', async () => {
    mockedSanitize.mockImplementation(() => ({ entries: [] }));
    const buffer = Buffer.from('docx-bytes');
    const svc = make();

    const pointer = await svc.uploadTemplateFile({
      projectId: 'p-1',
      fileName: '../evil.docx',
      buffer,
    });

    expect(pointer.bucket).toBe('fairflow-documents');
    expect(pointer.objectKey).toMatch(/^p-1\/templates\/.+-evil\.docx$/);
    expect(pointer.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(pointer.sizeBytes).toBe(buffer.length);
    expect(pointer.fileHash).toHaveLength(64);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'put' }));
  });

  it('uploadRecordDocument rejects unsupported MIME with 422', async () => {
    mockedValidate.mockReturnValue({ ok: false, code: 'UNSUPPORTED_MIME' } as never);
    const svc = make();

    await expect(
      svc.uploadRecordDocument({
        projectId: 'p-1',
        contextType: 'deal',
        buffer: Buffer.from('x'),
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('uploadRecordDocument stores validated files with sanitized path segments', async () => {
    mockedValidate.mockReturnValue({ ok: true, mimeType: 'application/pdf' } as never);
    const buffer = Buffer.from('pdf');
    const svc = make();

    const pointer = await svc.uploadRecordDocument({
      projectId: 'p-1',
      contextType: '../../deal',
      recordId: '../rec-1',
      fileName: 'scan.pdf',
      buffer,
    });

    expect(pointer.objectKey).toMatch(/^p-1\/uploads\/deal\/rec-1\/.+-scan\.pdf$/);
    expect(pointer.mimeType).toBe('application/pdf');
  });

  it('uploadRecordDocument rejects oversized files with localized message', async () => {
    mockedValidate.mockReturnValue({ ok: false, code: 'FILE_TOO_LARGE' } as never);
    const svc = make();

    await expect(
      svc.uploadRecordDocument({
        projectId: 'p-1',
        contextType: 'deal',
        buffer: Buffer.from('x'),
      }),
    ).rejects.toMatchObject({
      response: { code: 'FILE_TOO_LARGE', message: 'Файл превышает допустимый размер 20 МБ' },
    });
  });
});

describe('DocumentStorageService.sanitizeFileName', () => {
  it('strips path components and unsafe characters', () => {
    expect(DocumentStorageService.sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(DocumentStorageService.sanitizeFileName(undefined)).toBe('file');
  });
});
