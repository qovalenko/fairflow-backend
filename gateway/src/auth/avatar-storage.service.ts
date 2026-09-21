import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { AppConfigService } from '../config/app-config.service';

@Injectable()
export class AvatarStorageService {
  private readonly logger = new Logger(AvatarStorageService.name);
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

        const publicReadPolicy = {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'PublicReadForAvatarBucket',
              Effect: 'Allow',
              Principal: '*',
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${this.bucket}/*`],
            },
          ],
        };

        try {
          await this.client.send(
            new PutBucketPolicyCommand({
              Bucket: this.bucket,
              Policy: JSON.stringify(publicReadPolicy),
            }),
          );
        } catch (error) {
          this.logger.warn(
            `Failed to apply public read policy for ${this.bucket}: ${(error as Error).message}`,
          );
        }
      })();
    }
    return this.ensureBucketPromise;
  }

  private extensionFromFileName(name?: string): string {
    const ext = (name ? extname(name) : '').toLowerCase();
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') return ext;
    return '.jpg';
  }

  async uploadAvatar(params: {
    userId: string;
    fileName?: string;
    contentType?: string;
    buffer: Buffer;
  }): Promise<{ objectKey: string; publicUrl: string }> {
    await this.ensureBucket();

    const ext = this.extensionFromFileName(params.fileName);
    const objectKey = `users/${params.userId}/avatars/${Date.now()}-${randomUUID()}${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: params.buffer,
        ContentType: params.contentType || 'application/octet-stream',
      }),
    );

    return {
      objectKey,
      publicUrl: `${this.publicBaseUrl}/${this.bucket}/${objectKey}`,
    };
  }
}
