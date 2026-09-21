import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Counter, Gauge, Registry } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';
import { busQueueName } from '@fairflow/shared';

/** NFR-880: domain-specific observability for final-action saga, drift-gate, DLQ. */
@Injectable()
export class OrdersDomainMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersDomainMetricsService.name);
  private readonly finalActionTotal: Counter;
  private readonly driftGateTotal: Counter;
  private readonly dlqDepth: Gauge;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    metrics: MetricsService,
    @Optional() private readonly rabbit?: RabbitMqConsumer,
  ) {
    const registry: Registry = metrics.registry;
    this.finalActionTotal = new Counter({
      name: 'ff_orders_final_action_total',
      help: 'Final-action saga transitions in the orders domain',
      labelNames: ['result'],
      registers: [registry],
    });
    this.driftGateTotal = new Counter({
      name: 'ff_orders_drift_gate_total',
      help: 'Drift-gate evaluations before terminal move or document generation',
      labelNames: ['gate', 'outcome'],
      registers: [registry],
    });
    this.dlqDepth = new Gauge({
      name: 'ff_orders_dlq_depth',
      help: 'Dead-letter queue depth for orders bus consumers',
      registers: [registry],
    });
  }

  onModuleInit(): void {
    if (process.env.ORDERS_DLQ_METRICS_ENABLED === 'false') return;
    this.pollTimer = setInterval(() => void this.refreshDlqDepth(), 30_000);
    this.pollTimer.unref?.();
    void this.refreshDlqDepth();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  recordFinalAction(result: 'requested' | 'succeeded' | 'failed' | 'timeout'): void {
    this.finalActionTotal.inc({ result });
  }

  recordDriftGate(gate: 'terminal' | 'document', outcome: 'blocked' | 'passed'): void {
    this.driftGateTotal.inc({ gate, outcome });
  }

  private async refreshDlqDepth(): Promise<void> {
    if (!this.rabbit) return;
    try {
      const depth = await this.rabbit.dlqDepth(busQueueName('orders.final-action'));
      this.dlqDepth.set(depth);
    } catch (err) {
      this.logger.debug(`dlq depth poll failed: ${String(err)}`);
    }
  }
}
