import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { AppConfigService } from '../config/app-config.service';

/**
 * Private-bucket S3/MinIO uploader for chat attachments (FR-CHAT-16).
 *
 * The gateway streams the multipart bytes into the *same* bucket the documents
 * domain presigns from (`S3_DOCUMENTS_BUCKET`, default `fairflow-documents`).
 * Unlike the avatar bucket this stays PRIVATE — download access is granted only
 * through documents' short-lived presigned URLs scoped to conversation
 * membership (SEC-C-3). Object keys are prefixed with the projectId so the
 * documents domain's `objectKey.startsWith(projectId/)` guard passes.
 */
@Injectable()
export class ChatAttachmentStorageService {
  private readonly logger = new Logger(ChatAttachmentStorageService.name);
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
   * Upload chat attachment bytes into the private documents bucket and return
   * the storage pointer the documents domain persists (bucket/objectKey/hash).
   */
  async uploadChatAttachment(params: {
    projectId: string;
    conversationId: string;
    fileName?: string;
    contentType?: string;
    buffer: Buffer;
  }): Promise<{
    bucket: string;
    objectKey: string;
    fileHash: string;
    sizeBytes: number;
    mimeType: string;
  }> {
    await this.ensureBucket();

    const safeName = ChatAttachmentStorageService.sanitizeFileName(params.fileName);
    const objectKey = `${params.projectId}/chat/${params.conversationId}/${randomUUID()}-${safeName}`;
    const mimeType = params.contentType || 'application/octet-stream';
    const fileHash = createHash('sha256').update(params.buffer).digest('hex');

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: params.buffer,
        ContentType: mimeType,
      }),
    );

    return {
      bucket: this.bucket,
      objectKey,
      fileHash,
      sizeBytes: params.buffer.length,
      mimeType,
    };
  }
}
