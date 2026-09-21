import { BoxMongoReader } from './box-mongo';
import { boxUniqueName } from './conn';
import {
  archiveBoxTestProjectViaControl,
  createBoxTestProjectViaControl,
  gatewayMetadataCtx,
} from './control-project';
import { createBoxDeal, createPipeGrpcClient, type PipeGrpcClient } from './grpc-clients';
import { waitFor } from './wait-for';

/** Prime the box stand audit/notification consumers before integration specs (reduces cold-start flakiness). */
export async function warmupBoxConsumerPipeline(
  actorUserId: string,
  mongo: BoxMongoReader,
  pipe?: PipeGrpcClient,
): Promise<void> {
  const ownedPipe = pipe ?? createPipeGrpcClient();
  const projectId = await createBoxTestProjectViaControl(['deals', 'notifications'], actorUserId);
  try {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const sinceMs = Date.now();
      await createBoxDeal(ownedPipe, gatewayMetadataCtx(projectId, actorUserId), {
        name: boxUniqueName(`warmup-${attempt}`),
      });
      try {
        await waitFor(
          async () => mongo.findAuditEventSince(projectId, 'crm.deal.created', sinceMs),
          {
            label: `the box stand consumer warmup attempt ${attempt} (audit crm.deal.created)`,
            timeoutMs: 120_000,
          },
        );
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  } finally {
    await archiveBoxTestProjectViaControl(projectId, actorUserId).catch(() => undefined);
    if (!pipe) ownedPipe.close();
  }
}
