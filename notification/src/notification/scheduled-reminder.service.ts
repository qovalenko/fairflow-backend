import { Injectable } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { dedupKey, type EventEnvelope } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';

export type ScheduledReminderStatus = 'pending' | 'fired' | 'cancelled';

export type ScheduledReminderDoc = {
  _id: ObjectId;
  dedup_key: string;
  reminder_key: string;
  project_id: string;
  activity_id: string;
  recipient_id: string;
  fire_at: number;
  payload_json: string;
  status: ScheduledReminderStatus;
  created_at: number;
  updated_at: number;
  fired_at?: number;
  cancelled_at?: number;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

@Injectable()
export class ScheduledReminderService {
  constructor(private readonly mongo: MongoService) {}

  private collection() {
    return this.mongo.scheduledReminders();
  }

  async upsertFromEvent(env: EventEnvelope<Record<string, unknown>>): Promise<boolean> {
    const projectId = str(env.projectId);
    const p = (env.payload ?? {}) as Record<string, unknown>;
    const activityId = str(p.activityId ?? p.activity_id);
    const recipientId = str(p.recipientId ?? p.recipient_id ?? p.assigneeId);
    const fireAt = Number(p.fireAt ?? p.fire_at);
    if (!projectId || !activityId || !recipientId || !Number.isFinite(fireAt) || fireAt <= 0) {
      return false;
    }
    const reminderKey = str(p.reminderKey) || `activity.reminder:${activityId}`;
    const dedup = `${dedupKey(env)}`;
    const now = Date.now();
    // Never reset status on replay: a redelivered reminder_scheduled must not
    // resurrect a fired/cancelled row (fail-closed, TODO-116).
    const res = await this.collection().updateOne(
      { dedup_key: dedup },
      {
        $set: {
          reminder_key: reminderKey,
          project_id: projectId,
          activity_id: activityId,
          recipient_id: recipientId,
          fire_at: fireAt,
          payload_json: JSON.stringify(p),
          updated_at: now,
        },
        $setOnInsert: {
          dedup_key: dedup,
          status: 'pending',
          created_at: now,
        },
      },
      { upsert: true },
    );
    return res.upsertedCount > 0 || res.modifiedCount > 0;
  }

  async cancelByReminderKey(reminderKey: string): Promise<number> {
    const key = reminderKey.trim();
    if (!key) return 0;
    const now = Date.now();
    const res = await this.collection().updateMany(
      { reminder_key: key, status: 'pending' },
      { $set: { status: 'cancelled', cancelled_at: now, updated_at: now } },
    );
    return res.modifiedCount;
  }

  async findDueCandidates(limit = 100): Promise<ScheduledReminderDoc[]> {
    const cap = Math.max(1, Math.min(limit, 500));
    const now = Date.now();
    return (await this.collection()
      .find({ status: 'pending', fire_at: { $lte: now } })
      .sort({ fire_at: 1 })
      .limit(cap)
      .toArray()) as ScheduledReminderDoc[];
  }

  async claimDue(id: ObjectId): Promise<ScheduledReminderDoc | null> {
    const now = Date.now();
    const doc = await this.collection().findOneAndUpdate(
      { _id: id, status: 'pending', fire_at: { $lte: now } },
      { $set: { status: 'fired', fired_at: now, updated_at: now } },
      { returnDocument: 'before' },
    );
    return (doc as ScheduledReminderDoc | null) ?? null;
  }

  async releaseClaim(id: ObjectId): Promise<void> {
    const now = Date.now();
    await this.collection().updateOne(
      { _id: id, status: 'fired', fired_at: { $ne: null } },
      { $set: { status: 'pending', fired_at: null, updated_at: now } },
    );
  }

  async markCancelled(id: ObjectId): Promise<void> {
    const now = Date.now();
    await this.collection().updateOne(
      { _id: id },
      { $set: { status: 'cancelled', cancelled_at: now, updated_at: now } },
    );
  }
}
