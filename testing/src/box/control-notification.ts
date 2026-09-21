import { Metadata } from '@grpc/grpc-js';
import { GW_METADATA, serializeVisibilityScope } from '@fairflow/shared';
import type { BoxMongoReader } from './box-mongo';
import { deriveBoxAutomationServiceKey } from './conn';
import { findControlOutboxEvent } from './control-project';
import { waitFor } from './wait-for';

const SERVICE_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

/** Metadata for automation→peer s2s probes (matches {@link buildServiceActorMetadata}). */
export function buildAutomationServiceActorMetadata(
  projectId: string,
  userId?: string,
): Metadata {
  const md = new Metadata();
  md.set(GW_METADATA.SERVICE_API_KEY, deriveBoxAutomationServiceKey());
  md.set(GW_METADATA.PROJECT_ID, projectId);
  md.set(GW_METADATA.ACTOR_TYPE, 'service');
  md.set(GW_METADATA.VISIBILITY_SCOPE, SERVICE_SCOPE);
  md.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  if (userId) md.set(GW_METADATA.USER_ID, userId);
  return md;
}

/**
 * Wait for control.role.* notification materialization (#68).
 * Fails with outbox diagnostics when relay publishes but notification consumer does not.
 */
export async function waitForControlRoleNotificationMaterialized(
  mongo: BoxMongoReader,
  projectId: string,
  userId: string,
  routingKey: 'control.role.assigned' | 'control.role.revoked',
  sinceMs: number,
  timeoutMs = 180_000,
): Promise<Record<string, unknown>> {
  const outbox = await waitFor(
    async () => findControlOutboxEvent(projectId, routingKey, sinceMs),
    { label: `control outbox ${routingKey}`, timeoutMs: 60_000 },
  );
  const publishedKey = String(outbox?.routing_key ?? outbox?.routingKey ?? '');
  if (publishedKey !== routingKey) {
    throw new Error(`expected control outbox ${routingKey}, got ${publishedKey || 'none'}`);
  }

  return waitFor(
    async () => {
      const row = await mongo.findNotificationByEventType(projectId, userId, routingKey, sinceMs);
      return row ?? false;
    },
    {
      label: `notification for ${routingKey} (outbox published; probe checks notification consumer on the box stand)`,
      timeoutMs,
    },
  ) as Promise<Record<string, unknown>>;
}
