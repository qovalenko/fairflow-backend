import { buildOpsStatus } from '@fairflow/shared';
import { Controller, Get, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import type {
  OpsHealthzBody,
  OpsReadyzOkBody,
  OpsReadyzErrorBody,
  OpsStatusBody,
} from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('healthz')
  healthz(): OpsHealthzBody {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(@Res() reply: FastifyReply): Promise<FastifyReply> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: 'ok' } satisfies OpsReadyzOkBody);
    } catch {
      const body: OpsReadyzErrorBody = { status: 'error', message: 'database_not_ready' };
      return reply.status(503).send(body);
    }
  }

  @Get('status')
  status(): OpsStatusBody {
    return buildOpsStatus();
  }
}
