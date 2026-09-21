import { buildOpsStatus } from '@fairflow/shared';
import type {
  OpsHealthzBody,
  OpsReadyzErrorBody,
  OpsReadyzOkBody,
  OpsStatusBody,
} from '@fairflow/shared';
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { ReadinessService } from './readiness.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get('healthz')
  healthz(): OpsHealthzBody {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(@Res({ passthrough: false }) res: Response): Promise<void> {
    if (!this.readiness.isReady()) {
      const body: OpsReadyzErrorBody = {
        status: 'error',
        message: 'service_shutting_down',
      };
      res.status(503).json(body);
      return;
    }
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ status: 'ok' } satisfies OpsReadyzOkBody);
    } catch {
      const body: OpsReadyzErrorBody = {
        status: 'error',
        message: 'database_not_ready',
      };
      res.status(503).json(body);
    }
  }

  @Get('status')
  status(): OpsStatusBody {
    return buildOpsStatus();
  }
}
