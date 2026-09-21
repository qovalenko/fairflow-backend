import { Metadata, status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { GW_METADATA } from './metadata-keys';
import { resolveProjectId } from './inbound-metadata';

describe('resolveProjectId (FR-PROJ-030)', () => {
  function meta(projectId: string): Metadata {
    const m = new Metadata();
    m.set(GW_METADATA.PROJECT_ID, projectId);
    return m;
  }

  it('prefers trusted x-project-id metadata over body', () => {
    expect(resolveProjectId(meta('p-meta'), 'p-meta')).toBe('p-meta');
    expect(resolveProjectId(meta('p-meta'), '')).toBe('p-meta');
    expect(resolveProjectId(meta('p-meta'))).toBe('p-meta');
  });

  it('rejects body projectId that disagrees with metadata', () => {
    expect(() => resolveProjectId(meta('p-a'), 'p-b')).toThrow(RpcException);
  });

  it('falls back to non-empty body when metadata is absent (s2s)', () => {
    expect(resolveProjectId(undefined, 'p-body')).toBe('p-body');
  });

  it('fail-closed: both metadata and body empty → INVALID_ARGUMENT', () => {
    expect(() => resolveProjectId(undefined, '')).toThrow(RpcException);
    expect(() => resolveProjectId(undefined, '   ')).toThrow(RpcException);
    try {
      resolveProjectId(undefined);
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      const mapped = (err as RpcException).getError() as { code?: number; message?: string };
      expect(mapped.code).toBe(status.INVALID_ARGUMENT);
      expect(mapped.message).toContain('projectId is required');
    }
  });
});
