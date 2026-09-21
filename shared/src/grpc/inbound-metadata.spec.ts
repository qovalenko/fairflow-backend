import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { GW_METADATA } from './metadata-keys';
import { resolveProjectId } from './inbound-metadata';

function meta(projectId: string): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.PROJECT_ID, projectId);
  return m;
}

describe('resolveProjectId (FR-ACCESS-030)', () => {
  it('prefers trusted x-project-id metadata', () => {
    expect(resolveProjectId(meta('proj-a'))).toBe('proj-a');
    expect(resolveProjectId(meta('proj-a'), 'proj-a')).toBe('proj-a');
  });

  it('rejects body projectId when metadata disagrees', () => {
    expect(() => resolveProjectId(meta('proj-a'), 'proj-b')).toThrow(RpcException);
  });

  // s2s body fallback and fail-closed on empty — see resolve-project-id.spec.ts (FR-PROJ-030).
});
