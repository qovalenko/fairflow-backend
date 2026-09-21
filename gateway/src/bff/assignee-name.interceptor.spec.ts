import { of } from 'rxjs';
import { AssigneeNameInterceptor } from './assignee-name.interceptor';
import type { IdentityResolverService } from './identity-resolver.service';

describe('AssigneeNameInterceptor', () => {
  const req = { headers: {}, user: { userId: 'u-1' } } as never;

  function makeInterceptor(names: Map<string, string>) {
    const identity = {
      resolveNames: jest.fn().mockResolvedValue(names),
    } as unknown as IdentityResolverService;
    const interceptor = new AssigneeNameInterceptor(identity);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as never;
    return { interceptor, identity, ctx };
  }

  it('leaves non-object bodies untouched', async () => {
    const { interceptor, identity, ctx } = makeInterceptor(new Map());
    const next = { handle: () => of('plain') };

    const out = await new Promise((resolve, reject) => {
      interceptor.intercept(ctx, next).subscribe({ next: resolve, error: reject });
    });

    expect(out).toBe('plain');
    expect(identity.resolveNames).not.toHaveBeenCalled();
  });

  it('fills assigneeName from assigneeId in nested CRM payloads', async () => {
    const body = {
      deal: { assigneeId: 'u-1', assigneeName: '' },
      items: [{ assigneeId: 'u-2' }],
    };
    const { interceptor, identity, ctx } = makeInterceptor(
      new Map([
        ['u-1', 'Alice'],
        ['u-2', 'Bob'],
      ]),
    );
    const next = { handle: () => of(body) };

    const out = (await new Promise((resolve, reject) => {
      interceptor.intercept(ctx, next).subscribe({ next: resolve, error: reject });
    })) as typeof body;

    expect(identity.resolveNames).toHaveBeenCalledWith(req, ['u-1', 'u-2']);
    expect(out.deal.assigneeName).toBe('Alice');
    expect((out.items[0] as { assigneeName?: string }).assigneeName).toBe('Bob');
  });

  it('does not overwrite assigneeName when auth returns no names', async () => {
    const body = { assigneeId: 'u-unknown', assigneeName: 'raw-id' };
    const { interceptor, ctx } = makeInterceptor(new Map());
    const next = { handle: () => of(body) };

    const out = (await new Promise((resolve, reject) => {
      interceptor.intercept(ctx, next).subscribe({ next: resolve, error: reject });
    })) as typeof body;

    expect(out.assigneeName).toBe('raw-id');
  });

  it('skips objects without assigneeId', async () => {
    const body = { title: 'no assignee here' };
    const { interceptor, identity, ctx } = makeInterceptor(new Map([['u-1', 'Alice']]));
    const next = { handle: () => of(body) };

    await new Promise((resolve, reject) => {
      interceptor.intercept(ctx, next).subscribe({ next: resolve, error: reject });
    });

    expect(identity.resolveNames).not.toHaveBeenCalled();
  });

  it('ignores null and stops at max depth without infinite recursion', async () => {
    const cyclic: Record<string, unknown> = { assigneeId: 'u-1' };
    cyclic.self = cyclic;
    const { interceptor, identity, ctx } = makeInterceptor(new Map([['u-1', 'Alice']]));
    const next = { handle: () => of(cyclic) };

    const out = (await new Promise((resolve, reject) => {
      interceptor.intercept(ctx, next).subscribe({ next: resolve, error: reject });
    })) as typeof cyclic;

    expect(out.assigneeName).toBe('Alice');
    expect(identity.resolveNames).toHaveBeenCalled();
  });
});
