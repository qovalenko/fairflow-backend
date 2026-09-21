import { status as grpcStatus, Metadata } from '@grpc/grpc-js';
import { of, throwError, timer } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { GW_METADATA, parseVisibilityScope } from '@fairflow/shared';
import { NameResolverService } from './name-resolver.service';

/**
 * Builds a resolver with mocked gRPC clients. Each donor's Get* method is a jest.fn
 * returning an Observable; onModuleInit wires them via getService().
 */
function makeResolver(overrides: {
  contact?: jest.Mock;
  company?: jest.Mock;
  deal?: jest.Mock;
  order?: jest.Mock;
}) {
  const client = (svc: Record<string, unknown>) => ({ getService: () => svc }) as never;
  const contactSvc = { getContact: overrides.contact ?? jest.fn() };
  const companySvc = { getCompany: overrides.company ?? jest.fn() };
  const pipeSvc = { getDeal: overrides.deal ?? jest.fn() };
  const ordersSvc = { getOrder: overrides.order ?? jest.fn() };
  const svc = new NameResolverService(
    client(contactSvc),
    client(companySvc),
    client(pipeSvc),
    client(ordersSvc),
  );
  svc.onModuleInit();
  return svc;
}

describe('NameResolverService', () => {
  const PROJECT = 'p1';

  it('resolves display-names on success (contact ФИО, company/deal name, order number)', async () => {
    const svc = makeResolver({
      contact: jest.fn(() =>
        of({ first_name: 'Иван', middle_name: 'Петрович', last_name: 'Сидоров' }),
      ),
      company: jest.fn(() => of({ name: 'ООО Ромашка' })),
      deal: jest.fn(() => of({ name: 'Крупная сделка' })),
      order: jest.fn(() => of({ number: 'ORD-42', type_name: 'Продажа' })),
    });
    const out = await svc.resolveLinks(PROJECT, [
      { entityType: 'contact', entityId: 'c1' },
      { entityType: 'company', entityId: 'co1' },
      { entityType: 'deal', entityId: 'd1' },
      { entityType: 'order', entityId: 'o1' },
    ]);
    expect(out).toEqual([
      {
        entityType: 'contact',
        entityId: 'c1',
        nameSnapshot: 'Иван Петрович Сидоров',
        orphaned: false,
      },
      { entityType: 'company', entityId: 'co1', nameSnapshot: 'ООО Ромашка', orphaned: false },
      { entityType: 'deal', entityId: 'd1', nameSnapshot: 'Крупная сделка', orphaned: false },
      { entityType: 'order', entityId: 'o1', nameSnapshot: 'ORD-42', orphaned: false },
    ]);
  });

  it('passes the activity projectId into the donor request (isolation)', async () => {
    const getContact = jest.fn(() => of({ first_name: 'A', last_name: 'B' }));
    const svc = makeResolver({ contact: getContact });
    await svc.resolveLinks(PROJECT, [{ entityType: 'contact', entityId: 'c9' }]);
    expect(getContact).toHaveBeenCalledWith({ project_id: PROJECT, id: 'c9' }, expect.anything());
  });

  it('sends an x-visibility-scope header that parses to mode:all (donor fail-closed guard)', async () => {
    const getContact = jest.fn(() => of({ first_name: 'A', last_name: 'B' }));
    const svc = makeResolver({ contact: getContact });
    await svc.resolveLinks(PROJECT, [{ entityType: 'contact', entityId: 'c1' }]);
    const meta = (getContact.mock.calls[0] as unknown[])[1] as Metadata;
    const raw = meta.get(GW_METADATA.VISIBILITY_SCOPE)?.[0] as string | undefined;
    expect(raw).toBeTruthy();
    const scope = parseVisibilityScope(raw);
    expect(scope).toBeDefined();
    expect(scope?.mode).toBe('all');
    // service-api-key envelope + project isolation still stamped.
    expect(meta.get(GW_METADATA.PROJECT_ID)?.[0]).toBe(PROJECT);
    expect(meta.get(GW_METADATA.ACTOR_TYPE)?.[0]).toBe('service');
  });

  it('marks orphaned=true with empty snapshot when donor answers NOT_FOUND', async () => {
    const svc = makeResolver({
      contact: jest.fn(() => throwError(() => ({ code: grpcStatus.NOT_FOUND, message: 'no' }))),
    });
    const out = await svc.resolveLinks(PROJECT, [{ entityType: 'contact', entityId: 'gone' }]);
    expect(out).toEqual([
      { entityType: 'contact', entityId: 'gone', nameSnapshot: '', orphaned: true },
    ]);
  });

  it('leaves empty snapshot WITHOUT orphaned on timeout', async () => {
    // Observable that emits far later than the resolve timeout → rxjs TimeoutError.
    const svc = makeResolver({
      deal: jest.fn(() => timer(60_000).pipe(mergeMap(() => of({ name: 'late' })))),
    });
    const out = await svc.resolveLinks(PROJECT, [{ entityType: 'deal', entityId: 'd1' }]);
    expect(out).toEqual([
      { entityType: 'deal', entityId: 'd1', nameSnapshot: '', orphaned: false },
    ]);
  }, 10_000);

  it('leaves empty snapshot WITHOUT orphaned on UNAVAILABLE / transient error', async () => {
    const svc = makeResolver({
      company: jest.fn(() => throwError(() => ({ code: grpcStatus.UNAVAILABLE, message: 'down' }))),
    });
    const out = await svc.resolveLinks(PROJECT, [{ entityType: 'company', entityId: 'co1' }]);
    expect(out[0].orphaned).toBe(false);
    expect(out[0].nameSnapshot).toBe('');
  });

  it('dedupes identical entity references into a single RPC', async () => {
    const getDeal = jest.fn(() => of({ name: 'Deal X' }));
    const svc = makeResolver({ deal: getDeal });
    const out = await svc.resolveLinks(PROJECT, [
      { entityType: 'deal', entityId: 'same' },
      { entityType: 'deal', entityId: 'same' },
    ]);
    expect(getDeal).toHaveBeenCalledTimes(1);
    expect(out.every((l) => l.nameSnapshot === 'Deal X')).toBe(true);
  });

  it('is a no-op for empty links or missing projectId', async () => {
    const svc = makeResolver({});
    expect(await svc.resolveLinks(PROJECT, [])).toEqual([]);
    const links = [{ entityType: 'deal', entityId: 'd1' }];
    expect(await svc.resolveLinks('', links)).toBe(links);
  });
});
