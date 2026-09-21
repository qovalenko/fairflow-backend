import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Collection } from 'mongodb';
import { MongoService } from '../mongo/mongo.service';

/** Имя TTL-индекса guard-коллекции (нужно и для пересоздания при смене окна). */
const GUARD_TTL_INDEX_NAME = 'stats_rollup_msgs_ttl';
/** Окно дедупликации по умолчанию — 7 суток. */
const GUARD_TTL_DEFAULT_SEC = 7 * 24 * 60 * 60;

/** Окно дедупликации guard-коллекции в секундах (env с фолбэком на дефолт). */
function guardTtlSeconds(): number {
  const raw = Number(process.env.STATISTICS_ROLLUP_MSGS_TTL_SEC ?? GUARD_TTL_DEFAULT_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : GUARD_TTL_DEFAULT_SEC;
}

/**
 * A single materialized rollup cell (P2.f / FR-MSTAT-6/19). One row = the
 * running count (+ optional amount sum) of one `metric` in one project on one
 * UTC calendar `day`, optionally sliced by low-cardinality `dims`. NO record
 * ids ever live here — only aggregate counters keyed by `(projectId, metric,
 * day, dims)`. `projectId` is the first key of every index (tenant isolation).
 */
export interface StatisticsRollupDoc {
  projectId: string;
  metric: string;
  /** UTC calendar day `YYYY-MM-DD` the source fact occurred on. */
  day: string;
  /** Stable serialization of `dims` (empty string when no dims). */
  dimsKey: string;
  dims: Record<string, string>;
  /** Running event count. */
  value: number;
  /** Running money sum (only metrics whose payload carries `amount`). */
  amount: number;
  updatedAt: number;
  lastMessageId: string;
}

/** Idempotent increment intent applied exactly once per `messageId` (FR-MSTAT-19). */
export interface RollupIncrement {
  projectId: string;
  metric: string;
  day: string;
  dims?: Record<string, string>;
  /** Count delta (normally 1). */
  count: number;
  /** Optional money delta (won/created carry `amount`; others omit). */
  amount?: number;
  /** Transport/business dedup key (`idempotencyKey ?? messageId`). */
  messageId: string;
}

/** Stable, order-independent serialization of a dims object for the cell key. */
function serializeDims(dims: Record<string, string> | undefined): string {
  if (!dims) return '';
  const keys = Object.keys(dims).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${dims[k]}`).join('|');
}

/**
 * Materialized-rollup persistence for the statistics dashboard (P2.f). Increments
 * are applied idempotently by `messageId` (a duplicate delivery increments the
 * cell exactly once) via a per-(cell,messageId) guard collection — the exact
 * pattern proven by {@link OrgRollupStore}. Reads are NOT switched onto these
 * cells yet (no historical backfill) — see reports.service TODO.
 */
@Injectable()
export class StatisticsRollupStore implements OnModuleInit {
  constructor(private readonly mongo: MongoService) {}

  async onModuleInit(): Promise<void> {
    const col = this.mongo.statisticsRollup();
    // Unique cell key — also the idempotency anchor for the guard claim.
    await col.createIndex(
      { projectId: 1, metric: 1, day: 1, dimsKey: 1 },
      { unique: true, name: 'stats_rollup_cell_uk' },
    );
    // Read index (projectId first — tenant isolation).
    await col.createIndex(
      { projectId: 1, metric: 1, day: 1 },
      { name: 'stats_rollup_read' },
    );
    // TTL на guard-коллекцию: она растёт по строке на КАЖДОЕ событие шины и без
    // истечения жила вечно. Окно дедупликации должно лишь перекрывать возможные
    // повторные доставки/ретраи брокера, а не хранить историю (P2.f).
    const guard = this.mongo.statisticsRollupMsgs();
    await this.ensureGuardTtlIndex(guard, guardTtlSeconds());
    // Строки, записанные до этой правки, TTL не истечёт: у ранних `at` нет
    // вовсе, у более поздних он лежит числом (BSON double) — TTL реагирует
    // ТОЛЬКО на BSON Date. Разово нормализуем тип, не теряя ни одной заявки.
    await this.normalizeGuardTimestamps(guard);
  }

  /**
   * Создаёт TTL-индекс на guard-коллекции. Если индекс с этим именем уже есть с
   * другим окном (сменили `STATISTICS_ROLLUP_MSGS_TTL_SEC`), Mongo отвечает
   * IndexOptionsConflict (code 85) — тогда пересоздаём его под текущее окно.
   */
  private async ensureGuardTtlIndex(guard: Collection, ttlSec: number): Promise<void> {
    const spec = { at: 1 } as const;
    const options = { expireAfterSeconds: ttlSec, name: GUARD_TTL_INDEX_NAME };
    try {
      await guard.createIndex(spec, options);
    } catch (err) {
      if ((err as { code?: number }).code !== 85) throw err;
      await guard.dropIndex(GUARD_TTL_INDEX_NAME);
      await guard.createIndex(spec, options);
    }
  }

  /**
   * Приводит `at` к BSON Date у всех строк, где он им не является (нет поля —
   * ставим «сейчас», число миллисекунд — конвертируем в исходный момент, чтобы
   * просроченные строки ушли ближайшим проходом TTL-монитора). Заявку не
   * удаляем: удаление живой заявки вернуло бы двойной инкремент при повторной
   * доставке — ровно тот дефект, от которого guard и защищает.
   */
  private async normalizeGuardTimestamps(guard: Collection): Promise<void> {
    // `$not: { $type: 'date' }` матчит и документы без поля `at`.
    await guard.updateMany({ at: { $not: { $type: 'date' } } }, [
      { $set: { at: { $toDate: { $ifNull: ['$at', '$$NOW'] } } } },
    ]);
  }

  /**
   * Apply an increment to a rollup cell idempotently. The same `messageId`
   * applied twice increments the cell exactly once: a per-(cell,messageId)
   * processed-message guard records which messages already touched this cell,
   * and only the first claim proceeds to `$inc`.
   */
  async applyIncrement(inc: RollupIncrement): Promise<void> {
    const col = this.mongo.statisticsRollup();
    const guard = this.mongo.statisticsRollupMsgs();
    const dimsKey = serializeDims(inc.dims);

    // Idempotency: claim (cell + messageId). If already claimed → no-op.
    const claimId = `${inc.projectId}|${inc.metric}|${inc.day}|${dimsKey}|${inc.messageId}`;
    const claim = await guard.updateOne(
      { _id: claimId as never },
      {
        $setOnInsert: {
          projectId: inc.projectId,
          metric: inc.metric,
          // ОБЯЗАТЕЛЬНО BSON Date: TTL-индекс `stats_rollup_msgs_ttl` истекает
          // документы только по полю типа Date; число (BSON double) он молча
          // игнорирует и строка живёт вечно.
          at: new Date(),
        },
      },
      { upsert: true },
    );
    if (claim.upsertedCount === 0) return; // already applied (idempotent).

    const now = Date.now();
    await col.updateOne(
      { projectId: inc.projectId, metric: inc.metric, day: inc.day, dimsKey },
      {
        $inc: { value: inc.count, amount: inc.amount ?? 0 },
        $set: { updatedAt: now, lastMessageId: inc.messageId, dims: inc.dims ?? {} },
      },
      { upsert: true },
    );
  }

  /**
   * Read rollup rows for the scoped project/metrics in a `[dayFrom, dayTo]`
   * range. `projectId` first (tenant isolation); an empty projectId returns [].
   * Wired into getDashboard/getMetrics via coverage-gated read-switch (NFR-010).
   */
  async read(params: {
    projectId: string;
    metrics: string[];
    dayFrom: string;
    dayTo: string;
  }): Promise<StatisticsRollupDoc[]> {
    if (!params.projectId) return [];
    const cursor = this.mongo.statisticsRollup().find({
      projectId: params.projectId,
      metric: { $in: params.metrics },
      day: { $gte: params.dayFrom, $lte: params.dayTo },
    });
    return (await cursor.toArray()) as unknown as StatisticsRollupDoc[];
  }
}
