import { buildOpsStatus } from '@fairflow/shared';
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { OpsStatusBody } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';

/**
 * Ops-only HTTP surface (contracts/chat.md §1, NFR-CHAT-13): the chat domain
 * exposes NO business REST — only healthz/readyz/status/metrics. Realtime/REST
 * fan-out lives entirely on the gateway.
 */
@Controller()
export class HealthController {
  constructor(private readonly mongo: MongoService) {}

  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(@Res({ passthrough: false }) res: Response): Promise<void> {
    try {
      await this.mongo.healthPing();
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
