import { Metadata } from '@grpc/grpc-js';
import * as grpc from '@grpc/grpc-js';
import { BOX_PEER_GRPC } from './conn';
import { buildAutomationServiceActorMetadata } from './control-notification';
import { loadContactGrpcRaw } from './grpc-clients-internal';

export interface ContactS2sProbeResult {
  ok: boolean;
  elapsedMs: number;
  error?: string;
  grpcCode?: number;
  candidateCount?: number;
}

export type ContactFindDuplicatesProbeResult = ContactS2sProbeResult;

/**
 * Probe automation→contact s2s `FindDuplicates` (#61 / #62 contact bus).
 * Times out at `timeoutMs` to distinguish hang from auth rejection.
 */
export async function probeContactFindDuplicatesAsAutomationService(
  projectId: string,
  phone: string,
  email: string,
  timeoutMs = 15_000,
): Promise<ContactFindDuplicatesProbeResult> {
  const started = Date.now();
  const raw = loadContactGrpcRaw(BOX_PEER_GRPC.contact);
  const md = buildAutomationServiceActorMetadata(projectId);
  const fn = raw.FindDuplicates;
  if (typeof fn !== 'function') {
    return { ok: false, elapsedMs: Date.now() - started, error: 'FindDuplicates_missing' };
  }
  const bound = fn.bind(raw) as (
    req: Record<string, unknown>,
    md: Metadata,
    opts: { deadline: number },
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
  try {
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error(`timeout_${timeoutMs}ms`), { code: grpc.status.DEADLINE_EXCEEDED }));
      }, timeoutMs);
      bound(
        { project_id: projectId, phone, email },
        md,
        { deadline: Date.now() + timeoutMs },
        (err, res) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(res ?? {});
        },
      );
    });
    const candidates = (response.candidates ?? []) as unknown[];
    return {
      ok: true,
      elapsedMs: Date.now() - started,
      candidateCount: candidates.length,
    };
  } catch (err) {
    const grpcErr = err as grpc.ServiceError;
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      grpcCode: typeof grpcErr?.code === 'number' ? grpcErr.code : undefined,
    };
  } finally {
    const closer = raw.close as (() => void) | undefined;
    closer?.call(raw);
  }
}

/**
 * Probe automation→contact s2s `UpdateContact` (#62 contact bus).
 * Same hang signature as {@link probeContactFindDuplicatesAsAutomationService}.
 */
export async function probeContactUpdateContactAsAutomationService(
  projectId: string,
  contactId: string,
  timeoutMs = 15_000,
): Promise<ContactS2sProbeResult> {
  const started = Date.now();
  const raw = loadContactGrpcRaw(BOX_PEER_GRPC.contact);
  const md = buildAutomationServiceActorMetadata(projectId);
  const fn = raw.UpdateContact;
  if (typeof fn !== 'function') {
    return { ok: false, elapsedMs: Date.now() - started, error: 'UpdateContact_missing' };
  }
  const bound = fn.bind(raw) as (
    req: Record<string, unknown>,
    md: Metadata,
    opts: { deadline: number },
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
  try {
    await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error(`timeout_${timeoutMs}ms`), { code: grpc.status.DEADLINE_EXCEEDED }));
      }, timeoutMs);
      bound(
        { project_id: projectId, id: contactId, position: 'intclosure-s2s-probe' },
        md,
        { deadline: Date.now() + timeoutMs },
        (err, res) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(res ?? {});
        },
      );
    });
    return { ok: true, elapsedMs: Date.now() - started };
  } catch (err) {
    const grpcErr = err as grpc.ServiceError;
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      grpcCode: typeof grpcErr?.code === 'number' ? grpcErr.code : undefined,
    };
  } finally {
    const closer = raw.close as (() => void) | undefined;
    closer?.call(raw);
  }
}
