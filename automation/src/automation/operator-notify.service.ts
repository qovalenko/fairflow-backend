import { Injectable, Logger } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Transport } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { GW_METADATA } from '@fairflow/shared';
import { AUTOMATION_GRPC_LOADER_OPTIONS, protoPath } from './executors/grpc-action-executor';

export type OperatorNotifyInput = {
  projectId: string;
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
};

/**
 * Direct in-app notifications to operators (FR-AUTOM-105/170/190, NFR-030).
 * Uses NotificationGrpc.Send — same path as the send_notification executor.
 */
@Injectable()
export class OperatorNotifyService {
  private readonly logger = new Logger(OperatorNotifyService.name);
  private client: ClientGrpcProxy | null = null;

  async notify(input: OperatorNotifyInput): Promise<boolean> {
    const userId = input.userId.trim();
    if (!userId) return false;
    const url = process.env.NOTIFICATION_GRPC_URL?.trim();
    if (!url) {
      this.logger.warn('NOTIFICATION_GRPC_URL unset — operator notification skipped');
      return false;
    }
    try {
      const client = this.grpc();
      const svc = client.getService<{ Send: (req: unknown, meta: Metadata) => unknown }>(
        'NotificationGrpc',
      );
      const meta = new Metadata();
      meta.set(GW_METADATA.SERVICE_API_KEY, process.env.AUTOMATION_SERVICE_API_KEY ?? '');
      meta.set(GW_METADATA.GATEWAY_API_KEY_ID, process.env.AUTOMATION_API_KEY_ID ?? '');
      meta.set(GW_METADATA.REQUEST_ID, randomUUID());
      meta.set(GW_METADATA.TRACE_ID, randomUUID());
      meta.set(GW_METADATA.PROJECT_ID, input.projectId);
      meta.set(GW_METADATA.ACTOR_TYPE, 'service');
      meta.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
      await firstValueFrom(
        svc.Send(
          {
            project_id: input.projectId,
            user_id: userId,
            channel: 'in_app',
            title: input.title.slice(0, 200),
            body: input.body.slice(0, 4000),
            data_json: JSON.stringify({ source: 'automation', ...input.data }),
            email_to: '',
            idempotency_key: input.idempotencyKey ?? '',
          },
          meta,
        ) as never,
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `operator notify failed (${input.idempotencyKey ?? 'no-key'}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  private grpc(): ClientGrpcProxy {
    if (!this.client) {
      this.client = new ClientGrpcProxy({
        transport: Transport.GRPC,
        options: {
          url: process.env.NOTIFICATION_GRPC_URL,
          package: 'fairflow.notification.v1',
          protoPath: protoPath('fairflow', 'notification', 'v1', 'notification.proto'),
          loader: AUTOMATION_GRPC_LOADER_OPTIONS,
        },
      } as never);
    }
    return this.client;
  }
}
