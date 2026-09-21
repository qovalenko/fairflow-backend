import { status } from '@grpc/grpc-js';
import { NotificationService } from './notification.service';
import type { ControlMembersService } from '../control/control-members.service';

function buildService(members: Partial<ControlMembersService> = {}) {
  const controlMembers = {
    getEffectiveModulesWithStatus: jest
      .fn()
      .mockResolvedValue({ modules: ['deals', 'activities', 'orders', 'chat'], ok: true }),
    ...members,
  } as unknown as ControlMembersService;

  const service = new NotificationService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    controlMembers,
  );
  return { service, controlMembers };
}

describe('NotificationService.getCatalog (FR-PROFILE-240)', () => {
  const edition = process.env.FAIRFLOW_EDITION;

  afterAll(() => {
    if (edition === undefined) delete process.env.FAIRFLOW_EDITION;
    else process.env.FAIRFLOW_EDITION = edition;
  });

  beforeEach(() => {
    process.env.FAIRFLOW_EDITION = 'box';
  });

  it('returns edition catalog when project_id is empty', async () => {
    const { service, controlMembers } = buildService();
    const res = await service.getCatalog('');
    expect(res.categories.some((c) => c.category === 'deals')).toBe(true);
    expect(controlMembers.getEffectiveModulesWithStatus).not.toHaveBeenCalled();
  });

  it('filters categories by project effective modules', async () => {
    const { service } = buildService({
      getEffectiveModulesWithStatus: jest
        .fn()
        .mockResolvedValue({ modules: ['deals'], ok: true }),
    });
    const res = await service.getCatalog('p1');
    expect(res.categories.map((c) => c.category)).toContain('deals');
    expect(res.categories.some((c) => c.module === 'orders')).toBe(false);
    expect(res.categories.some((c) => c.module === 'activities')).toBe(false);
    expect(res.categories.map((c) => c.category)).toEqual(
      expect.arrayContaining(['org', 'data', 'import']),
    );
  });

  it('fail-closed when control is unavailable', async () => {
    const { service } = buildService({
      getEffectiveModulesWithStatus: jest.fn().mockResolvedValue({ modules: [], ok: false }),
    });
    await expect(service.getCatalog('p1')).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.UNAVAILABLE }),
    });
  });
});
