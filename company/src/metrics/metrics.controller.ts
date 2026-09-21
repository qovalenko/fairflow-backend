import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OPS_METRICS_CONTENT_TYPE } from '@fairflow/shared';
import { Public } from '../common/public.decorator';
import { MetricsService } from './metrics.service';

@ApiExcludeController()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Public()
  @Header('Content-Type', OPS_METRICS_CONTENT_TYPE)
  async getMetrics(): Promise<string> {
    return this.metrics.getMetrics();
  }
}
