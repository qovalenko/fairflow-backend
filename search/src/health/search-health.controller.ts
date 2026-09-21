import { buildOpsStatus } from '@fairflow/shared';
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { OpsHealthzBody, OpsReadyzErrorBody, OpsReadyzOkBody, OpsStatusBody } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';

// NOTE: `GET /metrics` is served solely by MetricsController (MetricsModule),
// backed by the single MetricsService registry that the MetricsInterceptor
// writes to. This controller used to register a SECOND `/metrics` route with its
// own empty registry (issue #27) — a duplicate route with divergent data. Removed.
@Controller()
export class SearchHealthController {
  constructor(private readonly mongo: MongoService) {}

  @Get('healthz')
  healthz(): OpsHealthzBody {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(@Res({ passthrough: false }) res: Response): Promise<void> {
    try {
      await this.mongo.healthPing();
      res.status(200).json({ status: 'ok' } satisfies OpsReadyzOkBody);
    } catch {
      const body: OpsReadyzErrorBody = { status: 'error', message: 'database_not_ready' };
      res.status(503).json(body);
    }
  }

  @Get('status')
  status(): OpsStatusBody {
    return buildOpsStatus();
  }
}
