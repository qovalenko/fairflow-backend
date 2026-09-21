import { Injectable } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { MongoService } from '../mongo/mongo.service';

type NotificationDoc = {
  _id: ObjectId;
  target: string;
  description: string;
  date: number;
  type: string;
  status: string;
  readed: boolean;
};

type AuditDoc = {
  _id: ObjectId;
  projectId: string;
  type: string;
  timestamp: number;
  userId: string;
  userName: string;
  entityType: string;
  entityId: string;
  changesJson: string;
};

@Injectable()
export class PlatformService {
  constructor(private readonly mongo: MongoService) {}

  private async ensureSeedData(): Promise<void> {
    const notifications = this.mongo.notifications();
    const templates = this.mongo.documentTemplates();
    const quotaRules = this.mongo.quotaRules();
    const hasNotifications = await notifications.countDocuments();
    if (hasNotifications === 0) {
      await notifications.insertOne({
        _id: new ObjectId(),
        target: 'Система',
        description: 'Добро пожаловать в Fairflow CRM',
        date: Date.now(),
        type: 'info',
        status: 'Обычный',
        readed: false,
      } satisfies Omit<NotificationDoc, '_id'> & { _id: ObjectId });
    }
    const hasTemplates = await templates.countDocuments({ projectId: 'default' });
    if (hasTemplates === 0) {
      await templates.insertOne({
        _id: new ObjectId(),
        projectId: 'default',
        name: 'Договор (шаблон)',
      });
    }
    const hasQuotaRules = await quotaRules.countDocuments({ projectId: 'default', action: 'documents.generate' });
    if (hasQuotaRules === 0) {
      await quotaRules.insertOne({
        _id: new ObjectId(),
        projectId: 'default',
        action: 'documents.generate',
        limit: 1000,
      });
    }
  }

  async notificationCount() {
    await this.ensureSeedData();
    const count = await this.mongo.notifications().countDocuments({ readed: { $ne: true } });
    return { count };
  }

  async listNotifications() {
    await this.ensureSeedData();
    const rows = (await this.mongo.notifications().find({}).sort({ date: -1 }).limit(100).toArray()) as NotificationDoc[];
    return {
      list: rows.map((n) => ({
        id: n._id.toString(),
        target: n.target,
        description: n.description,
        date: n.date,
        image: '',
        type: n.type,
        location: '',
        location_label: '',
        status: n.status,
        readed: n.readed,
      })),
    };
  }

  search(projectId: string, query: string) {
    const q = (query ?? '').toLowerCase();
    const hits = [
      { key: 'd1', path: `/p/${projectId}/deals`, title: 'Сделки', icon: 'deals', category: 'crm', categoryTitle: 'CRM' },
      { key: 'c1', path: `/p/${projectId}/contacts`, title: 'Контакты', icon: 'users', category: 'crm', categoryTitle: 'CRM' },
    ].filter((h) => !q || h.title.toLowerCase().includes(q) || 'crm'.includes(q));
    return {
      groups: [{ title: 'Навигация', hits }],
    };
  }

  async appendAudit(d: {
    project_id: string;
    type: string;
    user_id: string;
    user_name: string;
    entity_type: string;
    entity_id: string;
    changes_json: string;
  }) {
    const now = Date.now();
    await this.mongo.audit().insertOne({
      _id: new ObjectId(),
      projectId: d.project_id ?? '',
      type: d.type,
      timestamp: now,
      userId: d.user_id,
      userName: d.user_name,
      entityType: d.entity_type,
      entityId: d.entity_id,
      changesJson: d.changes_json,
    } satisfies Omit<AuditDoc, '_id'> & { _id: ObjectId });

    const keep = 2000;
    const count = await this.mongo.audit().countDocuments({ projectId: d.project_id ?? '' });
    if (count > keep) {
      const toDelete = count - keep;
      const oldRows = await this.mongo
        .audit()
        .find({ projectId: d.project_id ?? '' }, { projection: { _id: 1 } })
        .sort({ timestamp: 1, _id: 1 })
        .limit(toDelete)
        .toArray();
      if (oldRows.length > 0) {
        await this.mongo
          .audit()
          .deleteMany({ _id: { $in: oldRows.map((r) => r._id as ObjectId) } });
      }
    }
    return {};
  }

  async listAudit(projectId: string, pageSize: number) {
    const limit = Math.max(1, Math.min(pageSize || 50, 200));
    const rows = (await this.mongo
      .audit()
      .find({ projectId })
      .sort({ timestamp: -1, _id: -1 })
      .limit(limit)
      .toArray()) as AuditDoc[];
    return {
      list: rows.map((a) => ({
        id: a._id.toString(),
        type: a.type,
        timestamp: a.timestamp,
        user_id: a.userId,
        user_name: a.userName,
        entity_type: a.entityType,
        entity_id: a.entityId,
        changes_json: a.changesJson,
      })),
    };
  }

  async listDocumentTemplates(projectId: string) {
    await this.ensureSeedData();
    const pid = projectId || 'default';
    const rows = await this.mongo
      .documentTemplates()
      .find({ projectId: { $in: [pid, 'default'] } })
      .sort({ projectId: 1, _id: 1 })
      .toArray();
    return {
      list: rows.map((d) => ({
        id: (d._id as ObjectId).toString(),
        name: String((d as { name?: string }).name ?? ''),
      })),
    };
  }

  async checkQuota(userId: string, action: string) {
    await this.ensureSeedData();
    const projectId = userId || 'default';
    const rule = await this.mongo.quotaRules().findOne({ projectId, action });
    if (!rule) return { allowed: true, reason: '' };
    const usage = await this.mongo.quotaUsage().findOne({ projectId, action });
    const used = Number((usage as { used?: number } | null)?.used ?? 0);
    const limit = Number((rule as { limit?: number }).limit ?? 0);
    return {
      allowed: used < limit,
      reason: used < limit ? '' : 'quota_exceeded',
    };
  }

  async createUploadUrl(bucket: string, objectKey: string) {
    const token = new ObjectId().toString();
    await this.mongo.uploadTickets().insertOne({
      _id: new ObjectId(),
      token,
      bucket,
      objectKey,
      createdAt: Date.now(),
    });
    return {
      upload_url: `http://localhost:9000/upload/${bucket}/${objectKey}?ticket=${token}`,
      file_url: `http://localhost:9000/files/${bucket}/${objectKey}`,
    };
  }

  async dispatchWebhook(url: string, payloadJson: string) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: payloadJson,
      });
      await this.mongo.webhookLog().insertOne({
        _id: new ObjectId(),
        url,
        status: response.status,
        ok: response.ok,
        createdAt: Date.now(),
      });
      return { ok: response.ok, error: response.ok ? '' : `http_${response.status}` };
    } catch (error) {
      await this.mongo.webhookLog().insertOne({
        _id: new ObjectId(),
        url,
        status: 0,
        ok: false,
        createdAt: Date.now(),
        error: String(error),
      });
      return { ok: false, error: String(error) };
    }
  }
}
