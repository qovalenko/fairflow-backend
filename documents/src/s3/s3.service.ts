import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * S3/MinIO wrapper. Bucket is PRIVATE — no public `fileUrl` is ever returned
 * (FR-MDOC-20, closes the AS-IS diversion). Downloads only via short-lived
 * presigned URLs after the PDP/PEP + projectId-prefix check (B-2).
 */
@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;

  /** Default presign TTL (NFR-MDOC-3) and server-side cap. */
  static readonly DEFAULT_TTL_SEC = 900;
  static readonly MAX_TTL_SEC = 900;

  constructor(private readonly config: ConfigService) {
    const endpoint =
      config.get<string>('S3_ENDPOINT') ??
      process.env.S3_ENDPOINT ??
      'http://minio:9000';
    const region = config.get<string>('S3_REGION') ?? 'us-east-1';
    const accessKeyId =
      config.get<string>('S3_ACCESS_KEY') ??
      config.get<string>('S3_ACCESS_KEY_ID') ??
      '';
    const secretAccessKey =
      config.get<string>('S3_SECRET_KEY') ??
      config.get<string>('S3_SECRET_ACCESS_KEY') ??
      '';
    const forcePathStyle = (config.get<string>('S3_FORCE_PATH_STYLE') ?? 'true') === 'true';
    this.bucket = config.get<string>('S3_BUCKET') ?? 'fairflow-documents';

    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    });
  }

  get bucketName(): string {
    return this.bucket;
  }

  async uploadObject(
    objectKey: string,
    body: string | Buffer,
    contentType: string,
  ): Promise<{ bucket: string }> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { bucket: this.bucket };
  }

  /** Best-effort compensation when a domain write fails after S3 put (SEC-C-1). */
  async deleteObject(bucket: string, objectKey: string): Promise<void> {
    if (!objectKey) return;
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: bucket || this.bucket,
        Delete: { Objects: [{ Key: objectKey }], Quiet: true },
      }),
    );
  }

  /**
   * Fetch an object body as a Buffer (used by the DOCX sanitizer on upload —
   * FR-MDOC-9/10). The objectKey MUST already be project-prefix validated by the
   * caller (B-2); this method does not enforce isolation on its own.
   */
  async getObjectBuffer(bucket: string, objectKey: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: bucket || this.bucket, Key: objectKey }),
    );
    const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) {
      throw new Error('S3 object body is not readable');
    }
    return Buffer.from(await body.transformToByteArray());
  }

  /** Delete every object under `{projectId}/` (project hard-purge, RFC-4). */
  async deleteProjectPrefix(projectId: string): Promise<number> {
    const prefix = `${projectId}/`;
    let deleted = 0;
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      const keys = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === 'string' && k.length > 0);
      if (keys.length) {
        const res = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        deleted += (res.Deleted ?? []).length;
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  /** Short-lived presigned GET URL. ttl is server-capped (B-2). */
  async presignDownload(
    bucket: string,
    objectKey: string,
    ttlSec = S3Service.DEFAULT_TTL_SEC,
  ): Promise<{ url: string; expiresAt: number }> {
    const ttl = Math.max(1, Math.min(ttlSec || S3Service.DEFAULT_TTL_SEC, S3Service.MAX_TTL_SEC));
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: bucket || this.bucket, Key: objectKey }),
      { expiresIn: ttl },
    );
    return { url, expiresAt: Date.now() + ttl * 1000 };
  }

  /**
   * Delete objects in the bucket that are not in `referencedKeys` and are older than
   * `olderThanMs` (LastModified). Used by {@link S3OrphanGcService}.
   */
  async deleteUnreferencedObjects(
    referencedKeys: Set<string>,
    olderThanMs: number,
  ): Promise<{ scanned: number; deleted: number }> {
    let scanned = 0;
    let deleted = 0;
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ContinuationToken: token,
        }),
      );
      const stale: string[] = [];
      for (const obj of listed.Contents ?? []) {
        const key = obj.Key;
        if (!key || referencedKeys.has(key)) continue;
        scanned += 1;
        const modified = obj.LastModified?.getTime() ?? 0;
        if (modified > 0 && modified <= olderThanMs) stale.push(key);
      }
      if (stale.length) {
        const res = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: stale.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        deleted += (res.Deleted ?? []).length;
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
    return { scanned, deleted };
  }
}
