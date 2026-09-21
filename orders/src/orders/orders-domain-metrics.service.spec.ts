import { Registry } from 'prom-client';
import { busQueueName } from '@fairflow/shared';
import { MetricsService } from '../metrics/metrics.service';
import type { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';
import { OrdersDomainMetricsService } from './orders-domain-metrics.service';

describe('OrdersDomainMetricsService (NFR-880)', () => {
  const prevDlqFlag = process.env.ORDERS_DLQ_METRICS_ENABLED;

  afterEach(() => {
    process.env.ORDERS_DLQ_METRICS_ENABLED = prevDlqFlag;
    jest.useRealTimers();
  });

  it('exposes final-action, drift-gate and dlq metrics', async () => {
    const metrics = new MetricsService();
    const domain = new OrdersDomainMetricsService(metrics);
    domain.recordFinalAction('requested');
    domain.recordFinalAction('succeeded');
    domain.recordFinalAction('failed');
    domain.recordFinalAction('timeout');
    domain.recordDriftGate('terminal', 'blocked');
    domain.recordDriftGate('document', 'passed');
    const text = await metrics.getMetrics();
    expect(text).toContain('ff_orders_final_action_total');
    expect(text).toContain('ff_orders_drift_gate_total');
    expect(text).toContain('ff_orders_dlq_depth');
    expect(new Registry().getMetricsAsArray()).toBeDefined();
  });

  it('onModuleInit не запускает poll при ORDERS_DLQ_METRICS_ENABLED=false', () => {
    process.env.ORDERS_DLQ_METRICS_ENABLED = 'false';
    jest.useFakeTimers();
    const dlqDepth = jest.fn();
    const metrics = new MetricsService();
    const domain = new OrdersDomainMetricsService(metrics, {
      dlqDepth,
    } as unknown as RabbitMqConsumer);
    domain.onModuleInit();
    jest.advanceTimersByTime(60_000);
    expect(dlqDepth).not.toHaveBeenCalled();
    domain.onModuleDestroy();
  });

  it('onModuleInit опрашивает DLQ и onModuleDestroy останавливает таймер', async () => {
    delete process.env.ORDERS_DLQ_METRICS_ENABLED;
    jest.useFakeTimers();
    const dlqDepth = jest.fn().mockResolvedValue(3);
    const metrics = new MetricsService();
    const domain = new OrdersDomainMetricsService(metrics, {
      dlqDepth,
    } as unknown as RabbitMqConsumer);
    domain.onModuleInit();
    await Promise.resolve();
    expect(dlqDepth).toHaveBeenCalledWith(busQueueName('orders.final-action'));
    const text = await metrics.getMetrics();
    expect(text).toMatch(/ff_orders_dlq_depth 3/);
    domain.onModuleDestroy();
    dlqDepth.mockClear();
    jest.advanceTimersByTime(60_000);
    expect(dlqDepth).not.toHaveBeenCalled();
  });

  it('refreshDlqDepth проглатывает ошибку poll и не роняет сервис', async () => {
    const dlqDepth = jest.fn().mockRejectedValue(new Error('broker down'));
    const metrics = new MetricsService();
    const domain = new OrdersDomainMetricsService(metrics, {
      dlqDepth,
    } as unknown as RabbitMqConsumer);
    domain.onModuleInit();
    await Promise.resolve();
    await expect(metrics.getMetrics()).resolves.toContain('ff_orders_dlq_depth 0');
    domain.onModuleDestroy();
  });

  it('refreshDlqDepth no-op без RabbitMqConsumer', async () => {
    const metrics = new MetricsService();
    const domain = new OrdersDomainMetricsService(metrics);
    domain.onModuleInit();
    await Promise.resolve();
    await expect(metrics.getMetrics()).resolves.toContain('ff_orders_dlq_depth 0');
    domain.onModuleDestroy();
  });
});
