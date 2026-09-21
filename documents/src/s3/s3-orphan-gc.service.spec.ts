import { S3OrphanGcService } from './s3-orphan-gc.service';

describe('S3OrphanGcService (NFR-DOCS-050)', () => {
  it('deletes S3 keys not referenced in Mongo', async () => {
    const mongo = {
      documentVersions: () => ({
        find: () => ({
          toArray: async () => [{ objectKey: 'p1/documents/a/v1.docx' }],
        }),
      }),
      templateRevisions: () => ({
        find: () => ({
          toArray: async () => [{ objectKey: 'p1/templates/t1/v1.docx' }],
        }),
      }),
    };
    const s3 = {
      deleteUnreferencedObjects: jest.fn(async () => ({ scanned: 2, deleted: 1 })),
    };
    const svc = new S3OrphanGcService(mongo as never, s3 as never);
    const res = await svc.runOnce();
    expect(s3.deleteUnreferencedObjects).toHaveBeenCalledWith(
      new Set(['p1/documents/a/v1.docx', 'p1/templates/t1/v1.docx']),
      expect.any(Number),
    );
    expect(res.deleted).toBe(1);
  });

  it('returns zero when a run is already in progress', async () => {
    const mongo = {
      documentVersions: () => ({ find: () => ({ toArray: async () => [] }) }),
      templateRevisions: () => ({ find: () => ({ toArray: async () => [] }) }),
    };
    const s3 = { deleteUnreferencedObjects: jest.fn(async () => ({ scanned: 0, deleted: 0 })) };
    const svc = new S3OrphanGcService(mongo as never, s3 as never);
    (svc as unknown as { running: boolean }).running = true;
    await expect(svc.runOnce()).resolves.toEqual({ scanned: 0, deleted: 0 });
    expect(s3.deleteUnreferencedObjects).not.toHaveBeenCalled();
  });
});
