import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  sanitizeDocxBuffer,
  DocxValidationError,
  validateRecordUploadBuffer,
} from '@fairflow/shared';
import { AppConfigService } from '../config/app-config.service';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The storage pointer the documents domain persists (bucket/objectKey/hash). */
export interface StoredObjectPointer {
  bucket: string;
  objectKey: string;
  fileHash: string;
  sizeBytes: number;
  mimeType: string;
}

/**
 * Private-bucket S3/MinIO uploader for the documents module (BX-DOCS-1, FR-MDOC-9/
 * 10/21). The gateway streams the multipart bytes into the SAME private bucket the
 * documents domain presigns from (`S3_DOCUMENTS_BUCKET`, default
 * `fairflow-documents`) — download access is granted only through documents'
 * short-lived presigned URLs scoped to project membership. Object keys are
 * prefixed with the projectId so the domain's `objectKey.startsWith(projectId/)`
 * guard passes.
 *
 * Two upload flavours:
 *  - `uploadTemplateFile` — a DOCX template revision: the bytes are run through the
 *    shared active-content sanitizer (VBA/XXE/zip-bomb/OOXML) BEFORE they are ever
 *    persisted, so an unsafe file is rejected at the boundary (the domain re-checks
 *    the stored object authoritatively).
 *  - `uploadRecordDocument` — an arbitrary finished document attached to a record
 *    (any MIME); stored as-is (never rendered, so no active-content execution).
 */
@Injectable()
export class DocumentStorageService {
  private readonly logger = new Logger(DocumentStorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private ensureBucketPromise: Promise<void> | null = null;

  constructor(private readonly config: AppConfigService) {
    this.client = new S3Client({
      region: config.s3Region,
      endpoint: config.s3Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.s3AccessKeyId,
        secretAccessKey: config.s3SecretAccessKey,
      },
    });
    this.bucket = config.s3DocumentsBucket;
  }

  private async ensureBucket(): Promise<void> {
    if (!this.ensureBucketPromise) {
      this.ensureBucketPromise = (async () => {
        try {
          await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        } catch {
          try {
            await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
          } catch (error) {
            this.logger.warn(`Failed to ensure bucket ${this.bucket}: ${(error as Error).message}`);
          }
        }
      })();
    }
    return this.ensureBucketPromise;
  }

  /** Strip any path components and unsafe chars from a client-supplied name. */
  static sanitizeFileName(name?: string): string {
    const base = basename(name ?? '').trim();
    const safe = base
      .replace(/[^\w.\- ]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[._]+/, '')
      .slice(0, 128);
    return safe || 'file';
  }

  /**
   * Whitelist a client-supplied S3-key path segment to `[A-Za-z0-9_-]` so
   * `contextType`/`recordId` can never inject `/` or `..` and escape the project
   * prefix. Empty/all-stripped input falls back to a safe token.
   */
  static sanitizeKeySegment(value?: string): string {
    const safe = (value ?? '')
      .replace(/[^\w-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 128);
    return safe || 'x';
  }

  private async put(objectKey: string, buffer: Buffer, mimeType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: buffer,
        ContentType: mimeType,
      }),
    );
  }

  /**
   * Sanitize + upload a DOCX template revision. Rejects an unsafe file with HTTP
   * 422 (`TEMPLATE_INVALID` + `reason`) BEFORE it touches S3.
   */
  async uploadTemplateFile(params: {
    projectId: string;
    fileName?: string;
    buffer: Buffer;
  }): Promise<StoredObjectPointer> {
    try {
      sanitizeDocxBuffer(params.buffer);
    } catch (err) {
      if (err instanceof DocxValidationError) {
        throw new UnprocessableEntityException({
          code: 'TEMPLATE_INVALID',
          reason: err.reason,
          message: err.message,
        });
      }
      throw err;
    }

    const safeName = DocumentStorageService.sanitizeFileName(params.fileName);
    const objectKey = `${params.projectId}/templates/${randomUUID()}-${safeName}`;
    const fileHash = createHash('sha256').update(params.buffer).digest('hex');
    await this.put(objectKey, params.buffer, DOCX_MIME);
    return {
      bucket: this.bucket,
      objectKey,
      fileHash,
      sizeBytes: params.buffer.length,
      mimeType: DOCX_MIME,
    };
  }

  /**
   * Upload an arbitrary finished document to attach to a record (any MIME). Stored
   * as-is under the project prefix; never rendered by the template engine.
   */
  async uploadRecordDocument(params: {
    projectId: string;
    contextType: string;
    recordId?: string;
    fileName?: string;
    contentType?: string;
    buffer: Buffer;
  }): Promise<StoredObjectPointer> {
    const checked = validateRecordUploadBuffer(params.buffer);
    if (!checked.ok) {
      throw new UnprocessableEntityException({
        code: checked.code,
        message:
          checked.code === 'FILE_TOO_LARGE'
            ? 'Файл превышает допустимый размер 20 МБ'
            : 'Неподдерживаемый тип файла',
      });
    }
    const safeName = DocumentStorageService.sanitizeFileName(params.fileName);
    const safeContext = DocumentStorageService.sanitizeKeySegment(params.contextType);
    const scope = params.recordId
      ? `${safeContext}/${DocumentStorageService.sanitizeKeySegment(params.recordId)}`
      : 'none';
    const objectKey = `${params.projectId}/uploads/${scope}/${randomUUID()}-${safeName}`;
    const mimeType = checked.mimeType;
    const fileHash = createHash('sha256').update(params.buffer).digest('hex');
    await this.put(objectKey, params.buffer, mimeType);
    return {
      bucket: this.bucket,
      objectKey,
      fileHash,
      sizeBytes: params.buffer.length,
      mimeType,
    };
  }
}
