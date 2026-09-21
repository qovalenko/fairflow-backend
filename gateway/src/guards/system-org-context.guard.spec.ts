import { SystemOrgContextGuard } from './system-org-context.guard';

describe('SystemOrgContextGuard', () => {
  const systemOrg = { resolveSystemOrgId: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('always allows the request and stashes org id for authenticated users', async () => {
    systemOrg.resolveSystemOrgId.mockResolvedValue('org-1');
    const guard = new SystemOrgContextGuard(systemOrg as never);
    const req: {
      headers: Record<string, unknown>;
      user: { userId: string };
      __systemOrgId?: string;
    } = { headers: {}, user: { userId: 'u-1' } };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.__systemOrgId).toBe('org-1');
    expect(systemOrg.resolveSystemOrgId).toHaveBeenCalledWith(req);
  });

  it('does not resolve org id for anonymous requests but still allows access', async () => {
    const guard = new SystemOrgContextGuard(systemOrg as never);
    const req: { headers: Record<string, unknown>; __systemOrgId?: string } = { headers: {} };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.__systemOrgId).toBeUndefined();
    expect(systemOrg.resolveSystemOrgId).not.toHaveBeenCalled();
  });
});
