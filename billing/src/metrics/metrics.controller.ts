import { Controller, Get, Header } from '@nestjs/common';
import { OPS_METRICS_CONTENT_TYPE } from '@fairflow/shared';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('Content-Type', OPS_METRICS_CONTENT_TYPE)
  async getMetrics(): Promise<string> {
    return this.metrics.getMetrics();
  }
}
