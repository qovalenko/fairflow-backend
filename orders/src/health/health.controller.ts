import { buildOpsStatus, type OpsStatusBody } from '@fairflow/shared';
import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags, ApiExcludeController } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { Public } from '../common/public.decorator';
import { MongoService } from '../mongo/mongo.service';
import { ReadinessService } from './readiness.service';

@ApiTags('health')
@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(
    private readonly mongo: MongoService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get('healthz')
  @Public()
  healthz() {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Public()
  async readyz(@Res() reply: FastifyReply) {
    if (!this.readiness.isReady()) {
      return reply.status(503).send({ status: 'shutting_down' });
    }
    try {
      await this.mongo.getDb().command({ ping: 1 });
      return { status: 'ok' };
    } catch {
      return { status: 'error', message: 'Database not ready' };
    }
  }

  @Get('status')
  @Public()
  status(): OpsStatusBody {
    return buildOpsStatus();
  }
}
