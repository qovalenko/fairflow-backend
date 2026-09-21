const send = jest.fn();
const mockGetSignedUrl = jest.fn(async () => 'https://signed.example/get');

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send })),
  PutObjectCommand: jest.fn((input: unknown) => input),
  GetObjectCommand: jest.fn((input: unknown) => input),
  ListObjectsV2Command: jest.fn((input: unknown) => input),
  DeleteObjectsCommand: jest.fn((input: unknown) => input),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

import { S3Service } from './s3.service';

describe('S3Service', () => {
  const config = {
    get: (key: string) => {
      const map: Record<string, string> = {
        S3_BUCKET: 'fairflow-documents',
        S3_REGION: 'us-east-1',
        S3_ENDPOINT: 'http://minio:9000',
        S3_ACCESS_KEY: 'key',
        S3_SECRET_KEY: 'secret',
        S3_FORCE_PATH_STYLE: 'true',
      };
      return map[key];
    },
  };

  beforeEach(() => {
    send.mockReset();
    mockGetSignedUrl.mockClear();
  });

  it('uploadObject writes to the configured bucket', async () => {
    send.mockResolvedValue({});
    const svc = new S3Service(config as never);
    const res = await svc.uploadObject('p1/documents/x.docx', Buffer.from('data'), 'application/pdf');
    expect(res.bucket).toBe('fairflow-documents');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'fairflow-documents',
        Key: 'p1/documents/x.docx',
        ContentType: 'application/pdf',
      }),
    );
  });

  it('deleteObject is a no-op for an empty key', async () => {
    const svc = new S3Service(config as never);
    await svc.deleteObject('fairflow-documents', '');
    expect(send).not.toHaveBeenCalled();
  });

  it('getObjectBuffer reads the SDK body transform', async () => {
    send.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });
    const svc = new S3Service(config as never);
    await expect(svc.getObjectBuffer('fairflow-documents', 'p1/x.bin')).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it('getObjectBuffer rejects unreadable bodies', async () => {
    send.mockResolvedValue({ Body: {} });
    const svc = new S3Service(config as never);
    await expect(svc.getObjectBuffer('fairflow-documents', 'p1/x.bin')).rejects.toThrow(
      'not readable',
    );
  });

  it('presignDownload caps ttl to the server maximum', async () => {
    const svc = new S3Service(config as never);
    const before = Date.now();
    const res = await svc.presignDownload('fairflow-documents', 'p1/x.docx', 9999);
    expect(mockGetSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expiresIn: S3Service.MAX_TTL_SEC }),
    );
    expect(res.url).toBe('https://signed.example/get');
    expect(res.expiresAt).toBeGreaterThanOrEqual(before + S3Service.MAX_TTL_SEC * 1000 - 50);
  });

  it('deleteProjectPrefix walks paginated listings and deletes every key', async () => {
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'p1/a.docx' }, { Key: 'p1/b.docx' }],
        IsTruncated: true,
        NextContinuationToken: 'tok',
      })
      .mockResolvedValueOnce({ Deleted: [{ Key: 'p1/a.docx' }, { Key: 'p1/b.docx' }] })
      .mockResolvedValueOnce({ Contents: [{ Key: 'p1/c.docx' }], IsTruncated: false })
      .mockResolvedValueOnce({ Deleted: [{ Key: 'p1/c.docx' }] });
    const svc = new S3Service(config as never);
    await expect(svc.deleteProjectPrefix('p1')).resolves.toBe(3);
  });

  it('deleteUnreferencedObjects deletes only stale unreferenced keys', async () => {
    const old = new Date(Date.now() - 86_400_000);
    send
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'keep.docx', LastModified: old },
          { Key: 'orphan.docx', LastModified: old },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Deleted: [{ Key: 'orphan.docx' }] });
    const svc = new S3Service(config as never);
    const res = await svc.deleteUnreferencedObjects(new Set(['keep.docx']), Date.now() - 1000);
    expect(res).toEqual({ scanned: 1, deleted: 1 });
  });
});
