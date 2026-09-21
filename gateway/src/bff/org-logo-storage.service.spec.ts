import { UnprocessableEntityException } from '@nestjs/common';
import { OrgLogoStorageService } from './org-logo-storage.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://minio/presigned-put'),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  HeadBucketCommand: jest.fn(),
  CreateBucketCommand: jest.fn(),
  PutObjectCommand: jest.fn(),
}));

describe('OrgLogoStorageService (FR-ORG-030)', () => {
  const config = {
    s3Region: 'us-east-1',
    s3Endpoint: 'http://127.0.0.1:9000',
    s3AccessKeyId: 'k',
    s3SecretAccessKey: 's',
    s3AvatarsBucket: 'fairflow-avatars',
    s3PublicBaseUrl: 'http://cdn.test',
  };

  it('rejects unsupported MIME and oversize payloads', async () => {
    const svc = new OrgLogoStorageService(config as never);
    await expect(
      svc.createPresignedUpload({
        organizationId: 'org-1',
        contentType: 'application/pdf',
        contentLength: 100,
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      svc.createPresignedUpload({
        organizationId: 'org-1',
        contentType: 'image/png',
        contentLength: 6 * 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('returns presigned PUT + public logo URL', async () => {
    const svc = new OrgLogoStorageService(config as never);
    const res = await svc.createPresignedUpload({
      organizationId: 'org-1',
      contentType: 'image/png',
      fileName: 'logo.png',
      contentLength: 1024,
    });
    expect(res.uploadUrl).toBe('https://minio/presigned-put');
    expect(res.logoUrl).toContain('fairflow-avatars/orgs/org-1/logo/');
    expect(res.expiresAt).toBeGreaterThan(Date.now());
  });
});
