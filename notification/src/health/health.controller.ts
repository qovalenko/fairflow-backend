import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { buildOpsStatus, type OpsStatusBody } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';

@Controller()
export class HealthController {
  private readonly consumerEnabled = process.env.NOTIFICATION_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly mongo: MongoService,
    private readonly rabbit: RabbitMqService,
  ) {}

  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(@Res({ passthrough: false }) res: Response): Promise<void> {
    try {
      await this.mongo.healthPing();
      if (this.consumerEnabled && !this.rabbit.bound) {
        res.status(503).json({ status: 'error', message: 'consumer_not_bound' });
        return;
      }
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'error', message: 'database_not_ready' });
    }
  }

  @Get('status')
  status(): OpsStatusBody {
    return buildOpsStatus();
  }
}
