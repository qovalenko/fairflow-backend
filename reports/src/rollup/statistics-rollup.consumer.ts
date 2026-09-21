import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { ReportsRabbitMqConsumer } from '../messaging/rabbitmq-consumer.service';
import { StatisticsRollupStore } from './statistics-rollup.store';

/**
 * reports statistics-rollup consumer (P2.f · FR-MSTAT-6/19).
 *
 * Subscribes to the CRM change-facts on the shared bus and materializes them
 * into `statistics_rollup` cells `(projectId, metric, day)` with idempotent
 * increments (by `idempotencyKey ?? messageId`). Dashboard/metrics read-switch
 * (NFR-010) trusts these cells only after the per-project backfill marker.
 *
 * Queue: `<BUS_NAMESPACE>.reports.rollup` → retry ladder → DLQ (canonical
 * topology). `projectId`/`amount` are read ONLY from the envelope produced by
 * the source domain (already scoped), never from caller input.
 */

/** Map a routing-key → the rollup metric it increments (+ whether it carries `amount`). */
interface MetricRule {
  metric: string;
  /** Read `payload.amount` into the cell's money sum. */
  amount?: boolean;
}

/**
 * Only keys with a concrete counter live here. Extra keys are still bound on the
 * queue (see {@link BOUND_ROUTING_KEYS}) but ack-drop when unmapped, so a future
 * metric is a one-line addition without re-declaring the queue.
 */
const METRIC_RULES: Record<string, MetricRule> = {
  'crm.deal.created': { metric: 'deals_created', amount: true },
  'crm.deal.stage_changed': { metric: 'deals_stage_changed' },
  'crm.deal.won': { metric: 'deals_won', amount: true },
  'crm.deal.lost': { metric: 'deals_lost' },
  'crm.order.created': { metric: 'orders_created' },
  'crm.order.status_changed': { metric: 'orders_status_changed' },
  'crm.order.cancelled': { metric: 'orders_cancelled' },
  'crm.activity.created': { metric: 'activities_created' },
  'crm.activity.completed': { metric: 'activities_completed' },
};

/**
 * Every routing-key the queue binds. Superset of {@link METRIC_RULES}: the extra
 * keys (`crm.deal.updated`/`crm.deal.restored`/`crm.order.stage_changed`) are
 * bound for forward-compat but ack-drop until they get a rule.
 */
export const BOUND_ROUTING_KEYS = [
  'crm.deal.created',
  'crm.deal.updated',
  'crm.deal.stage_changed',
  'crm.deal.won',
  'crm.deal.lost',
  'crm.deal.restored',
  'crm.order.created',
  'crm.order.status_changed',
  'crm.order.stage_changed',
  'crm.order.cancelled',
  'crm.activity.created',
  'crm.activity.completed',
];

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** UTC calendar day `YYYY-MM-DD` from an ISO timestamp (fallback: now). */
function dayOf(timestamp: unknown): string {
  const ts = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  const d = Number.isFinite(ts) ? new Date(ts) : new Date();
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class StatisticsRollupConsumer implements OnModuleInit {
  private readonly logger = new Logger(StatisticsRollupConsumer.name);
  private readonly enabled = process.env.REPORTS_ROLLUP_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly rabbit: ReportsRabbitMqConsumer,
    private readonly store: StatisticsRollupStore,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('reports rollup consumer disabled (REPORTS_ROLLUP_CONSUMER_ENABLED=false)');
      return;
    }
    try {
      await this.rabbit.consume(
        busQueueName('reports.rollup'),
        BOUND_ROUTING_KEYS,
        (payload, routingKey) => this.handle(payload, routingKey),
      );
      this.logger.log(
        `reports rollup consumer bound to ${BOUND_ROUTING_KEYS.length} routing-keys`,
      );
    } catch (err) {
      // Do not block startup if the broker is down — the on-the-fly dashboard
      // aggregation still works (degrade gracefully). Reconnect is automatic.
      this.logger.error(`rollup consumer failed to bind: ${String(err)}`);
    }
  }

  /**
   * Materialize one CRM fact. Unmapped keys ack-drop. A malformed event with no
   * `projectId`/`messageId` is poison — it THROWS so the retry ladder eventually
   * dead-letters it (never a silent drop, never a mis-scoped increment).
   */
  async handle(payload: Record<string, unknown>, routingKey: string): Promise<void> {
    const rule = METRIC_RULES[routingKey];
    if (!rule) return; // bound but unmapped → ack & drop
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = str(env.projectId);
    if (!projectId) {
      // Poison: a scoped fact without a tenant cannot be materialized safely.
      throw new Error(`rollup event ${routingKey} without projectId`);
    }
    const messageId = str(env.idempotencyKey) || str(env.messageId);
    if (!messageId) {
      throw new Error(`rollup event ${routingKey} without messageId/idempotencyKey`);
    }
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const amount = rule.amount ? num(body.amount) : undefined;
    await this.store.applyIncrement({
      projectId,
      metric: rule.metric,
      day: dayOf(env.timestamp),
      count: 1,
      amount,
      messageId,
    });
    this.logger.debug(`rollup: ${routingKey} → ${rule.metric} (${projectId})`);
  }
}
