import { of } from 'rxjs';
import { PolicyImpactService } from './policy-impact.service';

describe('PolicyImpactService (FR-ACCESS-495)', () => {
  const build = (members: string[], allowByUser: Record<string, string[]>) => {
    const outboundMeta = {
      build: jest.fn(() => ({})),
    };
    const control = {
      getService: (name: string) => {
        if (name === 'ProjectGrpc') {
          return {
            listMembers: jest.fn(() =>
              of({
                list: members.map((id) => ({ user_id: id })),
              }),
            ),
          };
        }
        if (name === 'RoleGrpc') {
          return {
            resolveEffectivePermissions: jest.fn((req: { user_id?: string }) =>
              of({ allow: allowByUser[req.user_id ?? ''] ?? [] }),
            ),
          };
        }
        return {};
      },
    };
    const svc = new PolicyImpactService(control as never, outboundMeta as never);
    svc.onModuleInit();
    return svc;
  };

  it('counts affected users blocked by blanket deny rules', async () => {
    const svc = build(['u1', 'u2'], {
      u1: ['contacts:read'],
      u2: ['contacts:read', 'deals:read'],
    });
    const impact = await svc.estimate(
      { user: { userId: 'admin' } } as never,
      'p1',
      [
        {
          subject: 'contacts',
          action: '*',
          effect: 'deny',
          conditions: [],
        },
      ],
      ['contacts:read', 'contacts:write'],
    );
    expect(impact.affectedUsers.count).toBe(2);
    expect(impact.affectedRecords).toBeGreaterThan(0);
    expect(impact.ownerLockout).toBe(false);
  });
});
