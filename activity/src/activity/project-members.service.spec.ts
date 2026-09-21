import { status as grpcStatus, Metadata } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { GW_METADATA, parseVisibilityScope } from '@fairflow/shared';
import { ProjectMembersService } from './project-members.service';

/**
 * Builds a service with a mocked control `ProjectGrpc.ListMembers`. onModuleInit wires
 * the service via getService().
 */
function makeService(listMembers: jest.Mock) {
  const client = { getService: () => ({ listMembers }) } as never;
  const svc = new ProjectMembersService(client);
  svc.onModuleInit();
  return svc;
}

/** Extract a thrown RpcException's gRPC status code. */
async function grpcCode(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { error?: { code?: number } }).error?.code;
  }
}

describe('ProjectMembersService (SEC-PEP-2)', () => {
  const PROJECT = 'p1';

  it('passes when the assignee is a project member', async () => {
    const listMembers = jest.fn(() => of({ list: [{ id: 'u1' }, { id: 'u2' }] }));
    const svc = makeService(listMembers);
    await expect(svc.assertAssigneeMember(PROJECT, 'u2', 'u9')).resolves.toBeUndefined();
    expect(listMembers).toHaveBeenCalledWith({ project_id: PROJECT }, expect.anything());
  });

  it('rejects a non-member assignee with INVALID_ARGUMENT', async () => {
    const listMembers = jest.fn(() => of({ list: [{ id: 'u1' }] }));
    const svc = makeService(listMembers);
    expect(await grpcCode(() => svc.assertAssigneeMember(PROJECT, 'intruder', 'u9'))).toBe(
      grpcStatus.INVALID_ARGUMENT,
    );
  });

  it('short-circuits self-assign WITHOUT calling control', async () => {
    const listMembers = jest.fn(() => of({ list: [] }));
    const svc = makeService(listMembers);
    await expect(svc.assertAssigneeMember(PROJECT, 'u5', 'u5')).resolves.toBeUndefined();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('short-circuits empty assignee WITHOUT calling control', async () => {
    const listMembers = jest.fn(() => of({ list: [] }));
    const svc = makeService(listMembers);
    await expect(svc.assertAssigneeMember(PROJECT, '', 'u5')).resolves.toBeUndefined();
    await expect(svc.assertAssigneeMember(PROJECT, undefined, 'u5')).resolves.toBeUndefined();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('is FAIL-CLOSED: control down → UNAVAILABLE (mutation rejected)', async () => {
    const listMembers = jest.fn(() =>
      throwError(() => ({ code: grpcStatus.UNAVAILABLE, message: 'down' })),
    );
    const svc = makeService(listMembers);
    expect(await grpcCode(() => svc.assertAssigneeMember(PROJECT, 'someone', 'u9'))).toBe(
      grpcStatus.UNAVAILABLE,
    );
  });

  it('caches the member set (one control call within TTL)', async () => {
    const listMembers = jest.fn(() => of({ list: [{ id: 'u1' }] }));
    const svc = makeService(listMembers);
    await svc.assertAssigneeMember(PROJECT, 'u1', 'u9');
    await svc.assertAssigneeMember(PROJECT, 'u1', 'u9');
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it('sends the s2s all-scope + project isolation metadata to control', async () => {
    const listMembers = jest.fn(() => of({ list: [{ id: 'u1' }] }));
    const svc = makeService(listMembers);
    await svc.assertAssigneeMember(PROJECT, 'u1', 'u9');
    const meta = (listMembers.mock.calls[0] as unknown[])[1] as Metadata;
    const raw = meta.get(GW_METADATA.VISIBILITY_SCOPE)?.[0] as string | undefined;
    expect(parseVisibilityScope(raw)?.mode).toBe('all');
    expect(meta.get(GW_METADATA.PROJECT_ID)?.[0]).toBe(PROJECT);
    expect(meta.get(GW_METADATA.ACTOR_TYPE)?.[0]).toBe('service');
  });
});
