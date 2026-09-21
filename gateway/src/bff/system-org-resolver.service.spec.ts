import { of, throwError } from 'rxjs';
import { SystemOrgResolverService } from './system-org-resolver.service';

describe('SystemOrgResolverService', () => {
  const outboundMeta = { build: jest.fn(() => ({})) };

  function make(listResult: { list?: { id?: string }[] } | 'error') {
    const listMyOrganizations = jest.fn(() =>
      listResult === 'error' ? throwError(() => new Error('control down')) : of(listResult),
    );
    const control = { getService: jest.fn(() => ({ listMyOrganizations })) };
    const svc = new SystemOrgResolverService(control as never, outboundMeta as never);
    return { svc, listMyOrganizations };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty string without user id', async () => {
    const { svc } = make({ list: [{ id: 'org-1' }] });
    await expect(svc.resolveSystemOrgId({ headers: {} })).resolves.toBe('');
    expect(svc.getCachedOrgId()).toBe('');
  });

  it('resolves and caches the first organization id', async () => {
    const { svc, listMyOrganizations } = make({ list: [{ id: ' org-1 ' }] });
    const req = { headers: {}, user: { userId: 'u1' } };
    await expect(svc.resolveSystemOrgId(req)).resolves.toBe('org-1');
    expect(svc.getCachedOrgId()).toBe('org-1');
    await svc.resolveSystemOrgId(req);
    expect(listMyOrganizations).toHaveBeenCalledTimes(1);
  });

  it('does not cache empty results', async () => {
    const { svc, listMyOrganizations } = make({ list: [] });
    const req = { headers: {}, user: { userId: 'u1' } };
    await expect(svc.resolveSystemOrgId(req)).resolves.toBe('');
    expect(svc.getCachedOrgId()).toBe('');
    await svc.resolveSystemOrgId(req);
    expect(listMyOrganizations).toHaveBeenCalledTimes(2);
  });

  it('returns empty string on control failure', async () => {
    const { svc } = make('error');
    await expect(svc.resolveSystemOrgId({ headers: {}, user: { userId: 'u1' } })).resolves.toBe('');
  });

  it('invalidate drops cached anchor', async () => {
    const { svc } = make({ list: [{ id: 'org-1' }] });
    const req = { headers: {}, user: { userId: 'u1' } };
    await svc.resolveSystemOrgId(req);
    svc.invalidate();
    expect(svc.getCachedOrgId()).toBe('');
  });
});
