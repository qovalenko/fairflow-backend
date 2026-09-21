jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  HeadBucketCommand: jest.fn(),
  CreateBucketCommand: jest.fn(),
  PutBucketPolicyCommand: jest.fn(),
  PutObjectCommand: jest.fn(),
}));

import { AvatarStorageService } from './avatar-storage.service';

describe('AvatarStorageService', () => {
  const config = {
    s3Region: 'us-east-1',
    s3Endpoint: 'http://127.0.0.1:9000/',
    s3AccessKeyId: 'k',
    s3SecretAccessKey: 's',
    s3AvatarsBucket: 'fairflow-avatars',
    s3PublicBaseUrl: 'http://cdn.test/',
  };

  it('uploads avatar and returns public URL', async () => {
    const svc = new AvatarStorageService(config as never);
    const res = await svc.uploadAvatar({
      userId: 'u1',
      fileName: 'photo.PNG',
      contentType: 'image/png',
      buffer: Buffer.from('bytes'),
    });
    expect(res.objectKey).toMatch(/^users\/u1\/avatars\/\d+-.+\.png$/);
    expect(res.publicUrl).toBe(`http://cdn.test/fairflow-avatars/${res.objectKey}`);
  });

  it('defaults unknown extensions to .jpg', async () => {
    const svc = new AvatarStorageService(config as never);
    const res = await svc.uploadAvatar({
      userId: 'u1',
      fileName: 'photo.gif',
      buffer: Buffer.from('x'),
    });
    expect(res.objectKey.endsWith('.jpg')).toBe(true);
  });
});
