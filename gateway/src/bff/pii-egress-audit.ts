import { Logger } from '@nestjs/common';
import { grpcBffCall } from './grpc-bff-call';
import type { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';

const logger = new Logger('PiiEgressAudit');

export type PiiEgressChannel = 'export' | 'presigned_url' | 'email';

export type PiiEgressAuditPayload = {
  channel: PiiEgressChannel;
  /** CRM subject / entity family (`contacts`, `companies`, `documents`, …). */
  subject: string;
  format?: string;
  rowCount?: number;
  entityId?: string;
  scopeHash?: string;
  truncated?: boolean;
};

type AuditGrpc = { appendEvent: (x: unknown, m?: unknown) => unknown };

type GrpcReq = { user?: { userId?: string }; headers?: Record<string, unknown> };

/**
 * FR-COMPANIES-240 / 152-ФЗ: immutable audit fact when personal data leaves the
 * system (export file, presigned download URL). fail-soft — audit outage must not
 * block the user-facing operation.
 */
export async function appendPiiEgressAudit(
  audit: AuditGrpc | undefined,
  outboundMeta: GatewayOutboundMetadataService,
  req: GrpcReq,
  projectId: string,
  payload: PiiEgressAuditPayload,
): Promise<void> {
  if (!audit || !projectId) return;
  try {
    await grpcBffCall(
      audit.appendEvent(
        {
          project_id: projectId,
          event_name: 'pii.egressed',
          entity_type: payload.subject,
          entity_id: payload.entityId ?? projectId,
          payload_json: JSON.stringify({
            ...payload,
            ts: Date.now(),
          }),
        },
        outboundMeta.build(req as never, { projectId }),
      ) as never,
    );
  } catch (e) {
    logger.warn(
      `pii.egressed audit append failed (project=${projectId}, subject=${payload.subject}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
