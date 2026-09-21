import { AuthEmployeeGateService } from './auth-employee-gate.service';

jest.mock('../bff/grpc-bff-call', () => ({
  grpcBffCall: jest.fn(async (obs: unknown) => obs),
}));

import { grpcBffCall } from '../bff/grpc-bff-call';

describe('AuthEmployeeGateService (FR-AUTH-030)', () => {
  const grpcBffCallMock = grpcBffCall as jest.Mock;

  beforeEach(() => {
    grpcBffCallMock.mockReset();
    grpcBffCallMock.mockImplementation(async (obs: unknown) => obs);
  });

  function make(deps?: {
    orgId?: string | null;
    role?: Record<string, unknown>;
    roleError?: boolean;
  }) {
    const systemOrg = {
      resolveSystemOrgId: jest.fn().mockResolvedValue(deps?.orgId ?? 'org-1'),
    };
    const orgGrpc = {
      getOrgRole: jest.fn().mockImplementation(() => {
        if (deps?.roleError) throw new Error('control down');
        return deps?.role ?? { is_member: true, is_active: true };
      }),
    };
    const svc = new AuthEmployeeGateService(
      { getService: () => orgGrpc } as never,
      { build: () => ({}) } as never,
      systemOrg as never,
    );
    svc.onModuleInit();
    return { svc, orgGrpc, systemOrg };
  }

  it('returns true for an active org member', async () => {
    const { svc } = make();
    await expect(svc.isActiveEmployee('u1', { headers: {} } as never)).resolves.toBe(true);
  });

  it('returns false when user is not an active member', async () => {
    const { svc } = make({ role: { is_member: true, is_active: false } });
    await expect(svc.isActiveEmployee('u1', { headers: {} } as never)).resolves.toBe(false);
  });

  it('returns false when control is unreachable (fail-closed)', async () => {
    const { svc } = make({ roleError: true });
    await expect(svc.isActiveEmployee('u1', { headers: {} } as never)).resolves.toBe(false);
  });

  it('returns false for an empty userId (fail-closed)', async () => {
    const { svc, systemOrg } = make();
    await expect(svc.isActiveEmployee('', { headers: {} } as never)).resolves.toBe(false);
    expect(systemOrg.resolveSystemOrgId).not.toHaveBeenCalled();
  });
});
