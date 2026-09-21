jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  HeadBucketCommand: jest.fn(),
  CreateBucketCommand: jest.fn(),
  PutObjectCommand: jest.fn(),
}));

import { ChatAttachmentStorageService } from './chat-attachment-storage.service';

describe('ChatAttachmentStorageService', () => {
  const config = {
    s3Region: 'us-east-1',
    s3Endpoint: 'http://127.0.0.1:9000',
    s3AccessKeyId: 'k',
    s3SecretAccessKey: 's',
    s3DocumentsBucket: 'fairflow-documents',
  };

  it('sanitizeFileName strips path traversal and unsafe chars', () => {
    expect(ChatAttachmentStorageService.sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(ChatAttachmentStorageService.sanitizeFileName('  my file (1).pdf  ')).toBe(
      'my_file_1_.pdf',
    );
    expect(ChatAttachmentStorageService.sanitizeFileName('')).toBe('file');
  });

  it('uploads attachment under project/conversation prefix with sha256 hash', async () => {
    const svc = new ChatAttachmentStorageService(config as never);
    const buf = Buffer.from('hello');
    const res = await svc.uploadChatAttachment({
      projectId: 'p1',
      conversationId: 'conv-1',
      fileName: 'note.txt',
      contentType: 'text/plain',
      buffer: buf,
    });
    expect(res.bucket).toBe('fairflow-documents');
    expect(res.objectKey).toMatch(/^p1\/chat\/conv-1\/.+-note.txt$/);
    expect(res.fileHash).toHaveLength(64);
    expect(res.sizeBytes).toBe(5);
    expect(res.mimeType).toBe('text/plain');
  });
});
