import { buildOpsStatus } from '@fairflow/shared';
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { OpsHealthzBody, OpsReadyzErrorBody, OpsReadyzOkBody, OpsStatusBody } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';

/**
 * Ops health endpoints (`/healthz`, `/readyz`, `/status`). `/metrics` is owned
 * SOLELY by {@link MetricsController} (metrics module) so the exporter always
 * scrapes the one registry that the global {@link MetricsInterceptor} feeds —
 * a second `@Get('metrics')` here (backed by a separate Registry) shadowed the
 * route non-deterministically and dropped the HTTP metrics (#27).
 */
@Controller()
export class ReportsHealthController {
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
