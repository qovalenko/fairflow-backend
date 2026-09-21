import { RpcException } from '@nestjs/microservices';
import { status as grpcStatus } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { ProjectMembersService } from './project-members.service';

describe('ProjectMembersService (pipe)', () => {
  const listMembers = jest.fn();
  const client = {
    getService: () => ({ listMembers }),
  };

  beforeEach(() => {
    listMembers.mockReset();
    listMembers.mockReturnValue(of({ list: [{ id: 'u1' }, { id: 'u2' }] }));
  });

  it('no-ops for empty assignee', async () => {
    const svc = new ProjectMembersService(client as never);
    svc.onModuleInit();
    await expect(svc.assertAssigneeMember('p1', '')).resolves.toBeUndefined();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('no-ops for self-assign', async () => {
    const svc = new ProjectMembersService(client as never);
    svc.onModuleInit();
    await expect(svc.assertAssigneeMember('p1', 'u1', 'u1')).resolves.toBeUndefined();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('rejects a non-member assignee', async () => {
    const svc = new ProjectMembersService(client as never);
    svc.onModuleInit();
    await expect(svc.assertAssigneeMember('p1', 'u9', 'u1')).rejects.toMatchObject({
      error: { code: grpcStatus.INVALID_ARGUMENT },
    });
  });

  it('fail-closed when control is down', async () => {
    listMembers.mockReturnValue(throwError(() => new Error('control down')));
    const svc = new ProjectMembersService(client as never);
    svc.onModuleInit();
    await expect(svc.assertAssigneeMember('p1', 'u1')).rejects.toBeInstanceOf(RpcException);
  });
});
