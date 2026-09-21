import { ObjectId } from 'mongodb';
import { PlatformService } from './platform.service';
import type { MongoService } from '../mongo/mongo.service';

type ColMock = {
  countDocuments: jest.Mock;
  insertOne: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  deleteMany: jest.Mock;
};

function makeCollection(overrides: Partial<ColMock> = {}): ColMock {
  const cursor = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
  return {
    countDocuments: jest.fn().mockResolvedValue(0),
    insertOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockReturnValue(cursor),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    ...overrides,
  };
}

function makeService(collections: Record<string, ColMock>) {
  const mongo = {
    notifications: () => collections.notifications,
    documentTemplates: () => collections.documentTemplates,
    quotaRules: () => collections.quotaRules,
    quotaUsage: () => collections.quotaUsage,
    audit: () => collections.audit,
    uploadTickets: () => collections.uploadTickets,
    webhookLog: () => collections.webhookLog,
  };
  return new PlatformService(mongo as unknown as MongoService);
}

describe('PlatformService', () => {
  const notifications = makeCollection();
  const documentTemplates = makeCollection();
  const quotaRules = makeCollection();
  const quotaUsage = makeCollection();
  const audit = makeCollection();
  const uploadTickets = makeCollection();
  const webhookLog = makeCollection();

  let service: PlatformService;

  beforeEach(() => {
    jest.clearAllMocks();
    notifications.countDocuments.mockResolvedValue(1);
    documentTemplates.countDocuments.mockResolvedValue(1);
    quotaRules.countDocuments.mockResolvedValue(1);
    service = makeService({
      notifications,
      documentTemplates,
      quotaRules,
      quotaUsage,
      audit,
      uploadTickets,
      webhookLog,
    });
  });

  describe('notificationCount', () => {
    it('seeds demo data when collections are empty and counts unread notifications', async () => {
      notifications.countDocuments
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(2);
      documentTemplates.countDocuments.mockResolvedValueOnce(0);
      quotaRules.countDocuments.mockResolvedValueOnce(0);

      await expect(service.notificationCount()).resolves.toEqual({ count: 2 });

      expect(notifications.insertOne).toHaveBeenCalled();
      expect(documentTemplates.insertOne).toHaveBeenCalled();
      expect(quotaRules.insertOne).toHaveBeenCalled();
      expect(notifications.countDocuments).toHaveBeenLastCalledWith({ readed: { $ne: true } });
    });
  });

  describe('listNotifications', () => {
    it('maps stored notifications to the gRPC list shape', async () => {
      const id = new ObjectId();
      const row = {
        _id: id,
        target: 'Система',
        description: 'Тест',
        date: 123,
        type: 'info',
        status: 'Обычный',
        readed: false,
      };
      const cursor = notifications.find();
      cursor.toArray.mockResolvedValue([row]);

      await expect(service.listNotifications()).resolves.toEqual({
        list: [
          {
            id: id.toString(),
            target: 'Система',
            description: 'Тест',
            date: 123,
            image: '',
            type: 'info',
            location: '',
            location_label: '',
            status: 'Обычный',
            readed: false,
          },
        ],
      });
    });
  });

  describe('search', () => {
    it('returns navigation hits scoped to the project', () => {
      const result = service.search('proj-1', '');
      expect(result.groups[0].hits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/p/proj-1/deals', title: 'Сделки' }),
          expect.objectContaining({ path: '/p/proj-1/contacts', title: 'Контакты' }),
        ]),
      );
    });

    it('filters hits by query (case-insensitive)', () => {
      const result = service.search('proj-1', 'конт');
      expect(result.groups[0].hits).toEqual([
        expect.objectContaining({ title: 'Контакты' }),
      ]);
    });

    it('treats null/undefined query as empty and returns all hits', () => {
      const result = service.search('proj-1', undefined as unknown as string);
      expect(result.groups[0].hits).toHaveLength(2);
    });
  });

  describe('appendAudit', () => {
    it('inserts an audit row and returns an empty object', async () => {
      audit.countDocuments.mockResolvedValue(1);

      await expect(
        service.appendAudit({
          project_id: 'p1',
          type: 'update',
          user_id: 'u1',
          user_name: 'User',
          entity_type: 'deal',
          entity_id: 'd1',
          changes_json: '{}',
        }),
      ).resolves.toEqual({});

      expect(audit.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'p1',
          type: 'update',
          userId: 'u1',
          userName: 'User',
          entityType: 'deal',
          entityId: 'd1',
          changesJson: '{}',
        }),
      );
    });

    it('trims oldest audit rows when project exceeds the 2000-row cap', async () => {
      const oldId = new ObjectId();
      audit.countDocuments.mockResolvedValue(2001);
      const cursor = audit.find();
      cursor.toArray.mockResolvedValue([{ _id: oldId }]);

      await service.appendAudit({
        project_id: 'p1',
        type: 'update',
        user_id: 'u1',
        user_name: 'User',
        entity_type: 'deal',
        entity_id: 'd1',
        changes_json: '{}',
      });

      expect(audit.deleteMany).toHaveBeenCalledWith({ _id: { $in: [oldId] } });
    });

    it('uses empty project id when project_id is missing', async () => {
      audit.countDocuments.mockResolvedValue(0);

      await service.appendAudit({
        project_id: undefined as unknown as string,
        type: 'update',
        user_id: 'u1',
        user_name: 'User',
        entity_type: 'deal',
        entity_id: 'd1',
        changes_json: '{}',
      });

      expect(audit.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: '' }),
      );
    });
  });

  describe('listAudit', () => {
    it('clamps page size to [1, 200] and maps rows', async () => {
      const id = new ObjectId();
      const cursor = audit.find();
      cursor.toArray.mockResolvedValue([
        {
          _id: id,
          type: 'create',
          timestamp: 100,
          userId: 'u1',
          userName: 'User',
          entityType: 'deal',
          entityId: 'd1',
          changesJson: '{}',
        },
      ]);

      await expect(service.listAudit('p1', 999)).resolves.toEqual({
        list: [
          {
            id: id.toString(),
            type: 'create',
            timestamp: 100,
            user_id: 'u1',
            user_name: 'User',
            entity_type: 'deal',
            entity_id: 'd1',
            changes_json: '{}',
          },
        ],
      });
      expect(cursor.limit).toHaveBeenCalledWith(200);
    });

    it('treats zero page size as the default (50)', async () => {
      const cursor = audit.find();
      await service.listAudit('p1', 0);
      expect(cursor.limit).toHaveBeenCalledWith(50);
    });
  });

  describe('listDocumentTemplates', () => {
    it('loads templates for the project and the shared default project', async () => {
      const id = new ObjectId();
      const cursor = documentTemplates.find();
      cursor.toArray.mockResolvedValue([{ _id: id, name: 'Договор' }]);

      await expect(service.listDocumentTemplates('proj-1')).resolves.toEqual({
        list: [{ id: id.toString(), name: 'Договор' }],
      });

      expect(documentTemplates.find).toHaveBeenCalledWith({
        projectId: { $in: ['proj-1', 'default'] },
      });
    });

    it('falls back to default project when project id is empty', async () => {
      const cursor = documentTemplates.find();
      await service.listDocumentTemplates('');
      expect(documentTemplates.find).toHaveBeenCalledWith({
        projectId: { $in: ['default', 'default'] },
      });
    });
  });

  describe('checkQuota', () => {
    it('allows the action when no quota rule exists', async () => {
      quotaRules.findOne.mockResolvedValue(null);
      await expect(service.checkQuota('user-1', 'documents.generate')).resolves.toEqual({
        allowed: true,
        reason: '',
      });
    });

    it('denies when usage reached the configured limit', async () => {
      quotaRules.findOne.mockResolvedValue({ limit: 10 });
      quotaUsage.findOne.mockResolvedValue({ used: 10 });

      await expect(service.checkQuota('user-1', 'documents.generate')).resolves.toEqual({
        allowed: false,
        reason: 'quota_exceeded',
      });
    });

    it('allows when usage is below the limit', async () => {
      quotaRules.findOne.mockResolvedValue({ limit: 10 });
      quotaUsage.findOne.mockResolvedValue({ used: 3 });

      await expect(service.checkQuota('user-1', 'documents.generate')).resolves.toEqual({
        allowed: true,
        reason: '',
      });
    });

    it('uses default project id when user id is empty', async () => {
      quotaRules.findOne.mockResolvedValue(null);
      await service.checkQuota('', 'documents.generate');
      expect(quotaRules.findOne).toHaveBeenCalledWith({
        projectId: 'default',
        action: 'documents.generate',
      });
    });
  });

  describe('createUploadUrl', () => {
    it('persists an upload ticket and returns local MinIO-style URLs', async () => {
      const result = await service.createUploadUrl('docs', 'file.pdf');

      expect(uploadTickets.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: 'docs',
          objectKey: 'file.pdf',
          token: expect.any(String),
        }),
      );
      expect(result.upload_url).toContain('http://localhost:9000/upload/docs/file.pdf?ticket=');
      expect(result.file_url).toBe('http://localhost:9000/files/docs/file.pdf');
    });
  });

  describe('dispatchWebhook', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns ok=true and logs a successful webhook delivery', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      await expect(
        service.dispatchWebhook('https://example.com/hook', '{"a":1}'),
      ).resolves.toEqual({ ok: true, error: '' });

      expect(global.fetch).toHaveBeenCalledWith('https://example.com/hook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      });
      expect(webhookLog.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com/hook', ok: true, status: 200 }),
      );
    });

    it('returns ok=false with http status when the remote responds with an error', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 });

      await expect(
        service.dispatchWebhook('https://example.com/hook', '{}'),
      ).resolves.toEqual({ ok: false, error: 'http_502' });
    });

    it('logs transport failures and surfaces the error message', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

      await expect(
        service.dispatchWebhook('https://example.com/hook', '{}'),
      ).resolves.toEqual({ ok: false, error: 'Error: network down' });

      expect(webhookLog.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, status: 0, error: 'Error: network down' }),
      );
    });
  });
});
