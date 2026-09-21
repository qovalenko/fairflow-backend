import { buildOpsStatus } from '@fairflow/shared';
import { Controller, Get, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags, ApiExcludeController } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import type {
  OpsHealthzBody,
  OpsReadyzOkBody,
  OpsReadyzErrorBody,
  OpsStatusBody,
} from '@fairflow/shared';
import { Public } from '../common/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ReadinessService } from './readiness.service';

@ApiTags('health')
@ApiExcludeController()
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get('healthz')
  @Public()
  healthz(): OpsHealthzBody {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Public()
  async readyz(@Res() reply: FastifyReply): Promise<FastifyReply> {
    if (!this.readiness.isReady()) {
      const body: OpsReadyzErrorBody = { status: 'error', message: 'service_shutting_down' };
      return reply.status(503).send(body);
    }
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: 'ok' } satisfies OpsReadyzOkBody);
    } catch {
      const body: OpsReadyzErrorBody = { status: 'error', message: 'database_not_ready' };
      return reply.status(503).send(body);
    }
  }

  @Get('status')
  @Public()
  status(): OpsStatusBody {
    return buildOpsStatus();
  }
}
