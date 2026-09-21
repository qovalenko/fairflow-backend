import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { buildServiceOutboundMetadata } from '@fairflow/shared';
import { firstValueFrom, timeout } from 'rxjs';

export const ACTIVITY_GRPC = 'ACTIVITY_GRPC';

type ClaimReminderFireResponse = {
  claimed?: boolean;
  activity?: Record<string, unknown>;
};

@Injectable()
export class ActivityClaimService implements OnModuleInit {
  private readonly logger = new Logger(ActivityClaimService.name);
  private activityGrpc!: {
    claimReminderFire: (
      d: { project_id: string; activity_id: string; fire_at: number },
      md?: Metadata,
    ) => import('rxjs').Observable<ClaimReminderFireResponse>;
    releaseReminderFire: (
      d: { project_id: string; activity_id: string; fire_at: number },
      md?: Metadata,
    ) => import('rxjs').Observable<{ released?: boolean }>;
  };
  private readonly callTimeoutMs = parseInt(process.env.ACTIVITY_CLAIM_TIMEOUT_MS ?? '3000', 10);

  constructor(@Inject(ACTIVITY_GRPC) private readonly client: ClientGrpcProxy) {}

  onModuleInit(): void {
    this.activityGrpc = this.client.getService('ActivityGrpc');
  }

  private serviceApiKey(): string {
    return (
      process.env.NOTIFICATION_SERVICE_API_KEY?.trim() ||
      process.env.GATEWAY_SERVICE_API_KEY?.trim() ||
      ''
    );
  }

  private metadata(projectId: string): Metadata {
    const md = buildServiceOutboundMetadata({ serviceApiKey: this.serviceApiKey() });
    md.set('x-project-id', projectId);
    return md;
  }

  async claimReminderFire(
    projectId: string,
    activityId: string,
    fireAt: number,
  ): Promise<{ claimed: boolean; activity?: Record<string, unknown> }> {
    if (!projectId || !activityId || !Number.isFinite(fireAt)) return { claimed: false };
    try {
      const res = (await firstValueFrom(
        this.activityGrpc
          .claimReminderFire(
            { project_id: projectId, activity_id: activityId, fire_at: fireAt },
            this.metadata(projectId),
          )
          .pipe(timeout(this.callTimeoutMs)),
      )) as ClaimReminderFireResponse;
      return {
        claimed: res.claimed === true,
        activity: res.activity,
      };
    } catch (err) {
      this.logger.warn(
        `ClaimReminderFire failed for ${projectId}/${activityId}: ${String(err)}`,
      );
      // Transport/auth failure is not "unclaimable" — caller must retry.
      throw err;
    }
  }

  async releaseReminderFire(projectId: string, activityId: string, fireAt: number): Promise<void> {
    if (!projectId || !activityId || !Number.isFinite(fireAt)) return;
    try {
      await firstValueFrom(
        this.activityGrpc
          .releaseReminderFire(
            { project_id: projectId, activity_id: activityId, fire_at: fireAt },
            this.metadata(projectId),
          )
          .pipe(timeout(this.callTimeoutMs)),
      );
    } catch (err) {
      this.logger.warn(
        `ReleaseReminderFire failed for ${projectId}/${activityId}: ${String(err)}`,
      );
    }
  }
}
