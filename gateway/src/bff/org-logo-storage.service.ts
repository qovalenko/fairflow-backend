import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { AppConfigService } from '../config/app-config.service';

const LOGO_TTL_SEC = 300;
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']);

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

/**
 * FR-ORG-030 / FR-MORG-14: presigned PUT for the org logo. The gateway never
 * processes the binary — the client uploads directly to MinIO/S3, then PATCHes
 * `logoUrl` on the org profile.
 */
@Injectable()
export class OrgLogoStorageService {
  private readonly logger = new Logger(OrgLogoStorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
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
    this.bucket = config.s3AvatarsBucket;
    this.publicBaseUrl = config.s3PublicBaseUrl.replace(/\/+$/, '');
  }

  private async ensureBucket(): Promise<void> {
    if (!this.ensureBucketPromise) {
      this.ensureBucketPromise = (async () => {
        try {
          await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        } catch {
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        }
      })().catch((err) => {
        this.ensureBucketPromise = null;
        throw err;
      });
    }
    return this.ensureBucketPromise;
  }

  private resolveContentType(contentType?: string, fileName?: string): string {
    const ct = (contentType ?? '').trim().toLowerCase();
    if (ALLOWED_MIME.has(ct)) return ct;
    const ext = extname(fileName ?? '').toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.svg') return 'image/svg+xml';
    return '';
  }

  async createPresignedUpload(params: {
    organizationId: string;
    contentType?: string;
    fileName?: string;
    contentLength?: number;
  }): Promise<{
    uploadUrl: string;
    logoUrl: string;
    objectKey: string;
    expiresAt: number;
  }> {
    const len = Number(params.contentLength ?? 0);
    if (!Number.isFinite(len) || len <= 0) {
      throw new UnprocessableEntityException('contentLength is required');
    }
    if (len > MAX_LOGO_BYTES) {
      throw new UnprocessableEntityException('logo must be ≤ 5 MB');
    }
    const contentType = this.resolveContentType(params.contentType, params.fileName);
    if (!contentType) {
      throw new UnprocessableEntityException('only JPEG/PNG/WEBP/SVG logos are allowed');
    }

    await this.ensureBucket();
    const ext = MIME_EXT[contentType] ?? '.bin';
    const objectKey = `orgs/${params.organizationId}/logo/${Date.now()}-${randomUUID()}${ext}`;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: contentType,
        ContentLength: len,
      }),
      { expiresIn: LOGO_TTL_SEC },
    );
    const logoUrl = `${this.publicBaseUrl}/${this.bucket}/${objectKey}`;
    const expiresAt = Date.now() + LOGO_TTL_SEC * 1000;
    this.logger.log(`presigned org logo upload org=${params.organizationId} key=${objectKey}`);
    return { uploadUrl, logoUrl, objectKey, expiresAt };
  }
}
