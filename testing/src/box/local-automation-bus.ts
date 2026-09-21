import { connect } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { dedupKey, type EventEnvelope } from '@fairflow/shared';
import type { BoxMongoReader } from './box-mongo';
import { BOX_RABBITMQ_URL } from './conn';
import { waitFor } from './wait-for';
import { summarizeExecutions } from './wait-for-automation-bus';

/** Must match {@link localAutomationServiceEnv} `AUTOMATION_TRIGGER_QUEUE`. */
export const LOCAL_AUTOMATION_TRIGGER_QUEUE = 'intclosure-docs.automation.triggers';

const BOX_FF_PROTO_FAIL_RE =
  /invalid \.proto definition|proto undefined|\.proto.*not found/i;

function isBoxFfProtoPoison(exec: Record<string, unknown> | null | undefined): boolean {
  if (!exec || exec.status !== 'fail') return false;
  const blob = String(
    exec.action_results_json ?? exec.actionResultsJson ?? exec.error ?? '',
  );
  return BOX_FF_PROTO_FAIL_RE.test(blob);
}

async function resolveRecoveryEnvelope(
  mongo: BoxMongoReader,
  projectId: string,
  recovery: { routingKey: string; entityId: string },
  allowFreshDedup: boolean,
): Promise<EventEnvelope | null> {
  const fromOutbox = await mongo.findOutboxEnvelope(
    projectId,
    recovery.routingKey,
    recovery.entityId,
  );
  if (fromOutbox) return fromOutbox;

  const fromHook = await mongo.findEventHookEnvelope(
    projectId,
    recovery.routingKey,
    recovery.entityId,
  );
  if (!fromHook) return null;
  if (!allowFreshDedup) return fromHook;

  // Orders (and some peers) never land in `_outbox`; when the box stand claimed the
  // idempotency row and died without a visible fail doc, mint a fresh transport
  // id so the local consumer can claim again.
  return {
    ...fromHook,
    messageId: randomUUID(),
    idempotencyKey: `${recovery.routingKey}:${recovery.entityId}:local-recovery:${randomUUID()}`,
  };
}

/** Publish one envelope straight to the local automation trigger work queue. */
export async function publishToLocalAutomationTriggerQueue(
  envelope: EventEnvelope,
): Promise<void> {
  const conn = await connect(BOX_RABBITMQ_URL);
  try {
    const ch = await conn.createChannel();
    try {
      ch.sendToQueue(LOCAL_AUTOMATION_TRIGGER_QUEUE, Buffer.from(JSON.stringify(envelope)), {
        persistent: true,
        contentType: 'application/json',
        messageId: envelope.messageId,
        correlationId: dedupKey(envelope),
        timestamp: Math.floor(new Date(envelope.timestamp).getTime() / 1000),
        type: envelope.type,
        headers: {
          'x-project-id': envelope.projectId ?? '',
          'x-source': envelope.source,
          'x-version': envelope.version,
        },
      });
    } finally {
      await ch.close();
    }
  } finally {
    await conn.close();
  }
}

/**
 * Like {@link waitForBusTriggeredAutomation}, but when the box stand automation claims
 * the idempotency row first and fails with a broken proto loader, clears the
 * poisoned execution and re-delivers the canonical outbox envelope to the local
 * trigger queue only.
 */
export async function waitForBusTriggeredAutomationLocal(
  mongo: BoxMongoReader,
  projectId: string,
  ruleId: string,
  poll: () => Promise<Record<string, unknown> | false>,
  label: string,
  recovery: { routingKey: string; entityId: string },
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  let recovered = false;
  try {
    return await waitFor(
      async () => {
        const row = await poll();
        if (row) return row;

        if (!recovered) {
          const exec = (await mongo.findAutomationExecution(projectId, ruleId)) as
            | Record<string, unknown>
            | null;
          const poisoned = isBoxFfProtoPoison(exec);
          const outboxEnvelope = await mongo.findOutboxEnvelope(
            projectId,
            recovery.routingKey,
            recovery.entityId,
          );

          if (poisoned) {
            await mongo.deleteAutomationExecutions(projectId, ruleId);
            const envelope =
              outboxEnvelope ??
              (await mongo.findEventHookEnvelope(
                projectId,
                recovery.routingKey,
                recovery.entityId,
              ));
            if (envelope) {
              await publishToLocalAutomationTriggerQueue(envelope);
              recovered = true;
            }
          } else if (!exec && !outboxEnvelope) {
            // Peers like orders publish to the bus without `_outbox` rows; when
            // the box stand claims idempotency and bails, replay from event hooks.
            const envelope = await resolveRecoveryEnvelope(
              mongo,
              projectId,
              recovery,
              true,
            );
            if (envelope) {
              await publishToLocalAutomationTriggerQueue(envelope);
              recovered = true;
            }
          }
        }
        return false;
      },
      { label, timeoutMs, intervalMs: 500 },
    );
  } catch (err) {
    const executions = await mongo.listAutomationExecutions(projectId, ruleId);
    throw new Error(
      `${String(err)} — executions: ${summarizeExecutions(executions as Record<string, unknown>[])}`,
    );
  }
}
