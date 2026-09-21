import { MODULE_METRIC_NAMES } from '@fairflow/shared';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  it('GET /metrics отдаёт prometheus text из MetricsService (включая RunReport)', async () => {
    const metrics = new MetricsService();
    metrics.recordModuleRequest('RunReport', 'ok', 10);
    const ctrl = new MetricsController(metrics);

    const body = await ctrl.getMetrics();

    expect(body).toContain(MODULE_METRIC_NAMES.REQUEST_DURATION_MS);
    expect(body).toContain('module="reports"');
    expect(body).toContain('method="RunReport"');
  });

  it('проксирует строку, которую вернул MetricsService.getMetrics', async () => {
    const metrics = { getMetrics: jest.fn().mockResolvedValue('PROM_FROM_SERVICE') };
    const ctrl = new MetricsController(metrics as unknown as MetricsService);

    await expect(ctrl.getMetrics()).resolves.toBe('PROM_FROM_SERVICE');
    expect(metrics.getMetrics).toHaveBeenCalledTimes(1);
  });
});
