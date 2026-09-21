import { busQueueName } from '@fairflow/shared';
import * as amqp from 'amqplib';
import { BOX_CONN } from './env';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;

/** Peer work-queues for `control.member.offboarded` (catalog #45–#49). */
export const MEMBER_OFFBOARD_PEER_QUEUES = [
  'contact.member-offboarded',
  'company.member-offboarded',
  'orders.member-offboarded',
  'activity.member-offboarded',
  'documents.member-offboarded',
  'pipe.member-offboarded',
] as const;

/** Peer work-queues for `control.project.purged` (catalog #50). */
export const PROJECT_PURGE_PEER_QUEUES = [
  'contact.project-purge',
  'company.project-purge',
  'orders.project-purge',
  'activity.project-purge',
  'documents.project-purge',
  'pipe.project-purge',
  'search.project-purge',
] as const;

export interface BoxQueueStats {
  queue: string;
  messageCount: number;
  consumerCount: number;
}

export interface BoxQueueMissing {
  queue: string;
  notFound: true;
}

export type BoxQueueProbe = BoxQueueStats | BoxQueueMissing;

async function probeQueueOnConnection(
  connection: AmqpConnection,
  baseName: string,
): Promise<BoxQueueProbe> {
  const queue = busQueueName(baseName);
  const channel = await connection.createChannel();
  channel.on('error', () => undefined);
  try {
    const info = await channel.checkQueue(queue);
    return { queue, messageCount: info.messageCount, consumerCount: info.consumerCount };
  } catch {
    return { queue, notFound: true };
  } finally {
    await channel.close().catch(() => undefined);
  }
}

/** Read-only RabbitMQ probe for the box stand peer consumer diagnosis. */
export class BoxRabbitHelper {
  private constructor(private readonly connection: AmqpConnection) {}

  static async connect(): Promise<BoxRabbitHelper> {
    const connection = await amqp.connect(BOX_CONN.rabbitmq);
    connection.on('error', () => undefined);
    return new BoxRabbitHelper(connection);
  }

  async close(): Promise<void> {
    await this.connection.close().catch(() => undefined);
  }

  /** Passive queue declare; returns `notFound` when the queue was never created on the broker. */
  async probeQueue(baseName: string): Promise<BoxQueueProbe> {
    return probeQueueOnConnection(this.connection, baseName);
  }

  async probeMemberOffboardPeers(): Promise<BoxQueueProbe[]> {
    return Promise.all(
      MEMBER_OFFBOARD_PEER_QUEUES.map((q) => probeQueueOnConnection(this.connection, q)),
    );
  }

  async probeProjectPurgePeers(): Promise<BoxQueueProbe[]> {
    return Promise.all(
      PROJECT_PURGE_PEER_QUEUES.map((q) => probeQueueOnConnection(this.connection, q)),
    );
  }
}

/** Format peer queue probe for bug reports (consumers=0 or queue missing → peer not wired on the box stand). */
export function formatPeerQueueProbe(probes: BoxQueueProbe[]): string {
  return probes
    .map((p) => formatSinglePeerQueueProbe(p))
    .join('\n');
}

export function formatSinglePeerQueueProbe(probe: BoxQueueProbe): string {
  if ('notFound' in probe) return `${probe.queue}: NOT_FOUND`;
  return `${probe.queue}: messages=${probe.messageCount} consumers=${probe.consumerCount}`;
}

/** True when the peer queue exists on the box stand and at least one consumer is bound. */
export function isPeerQueueWired(probe: BoxQueueProbe): boolean {
  return !('notFound' in probe) && probe.consumerCount > 0;
}

/**
 * Fail fast when a catalog peer consumer is not wired on the box stand (queue missing or 0 consumers).
 * Use after control outbox publish — if this throws, the integration edge cannot pass yet.
 */
export function assertPeerQueueWired(baseName: string, probe: BoxQueueProbe): void {
  if (isPeerQueueWired(probe)) return;
  throw new Error(
    `the box stand peer consumer not wired for ${baseName}: ${formatSinglePeerQueueProbe(probe)}`,
  );
}
