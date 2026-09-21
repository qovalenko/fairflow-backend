import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { V1DataBffController } from './v1-data-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function build(
  services: {
    company?: Record<string, unknown>;
    contact?: Record<string, unknown>;
    pipe?: Record<string, unknown>;
    orders?: Record<string, unknown>;
    activity?: Record<string, unknown>;
    audit?: Record<string, unknown>;
  } = {},
) {
  const outboundMeta = { build: () => ({}) } as never;
  const ctrl = new V1DataBffController(
    stubClient(),
    stubClient(services.contact ?? {}),
    stubClient(services.company ?? {}),
    stubClient(),
    stubClient(),
    stubClient(services.audit ?? {}),
    stubClient(services.pipe ?? {}),
    stubClient(services.orders ?? {}),
    stubClient(services.activity ?? {}),
    stubClient(),
    stubClient(),
    outboundMeta,
    {} as never,
    {} as never,
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = {
  headers: {},
  user: { userId: 'u1' },
  __donorAccess: {
    contacts: { scope: 's-contacts', predicate: 'p-contacts' },
    deals: { scope: 's-deals', predicate: 'p-deals' },
    orders: { scope: 's-orders', predicate: 'p-orders' },
    activities: { scope: 's-act', predicate: 'p-act' },
  },
} as never;

describe('getCompanyCard cache / FR-COMPANIES-220', () => {
  it('reuses cached payload when cardContactsRev is unchanged', async () => {
    const getCompany = jest.fn(() => of({ id: 'co1', name: 'Acme', card_contacts_rev: 3 }));
    const listContacts = jest.fn(() => of({ list: [], total: 0 }));
    const listDeals = jest.fn(() => of({ list: [], total: 0 }));
    const listOrders = jest.fn(() => of({ list: [], total: 0 }));
    const listActivities = jest.fn(() => of({ list: [] }));
    const listEvents = jest.fn(() => of({ list: [] }));
    const ctrl = build({
      company: { getCompany },
      contact: { listContacts },
      pipe: { listDeals },
      orders: { listOrders },
      activity: { listActivities },
      audit: { listEvents },
    });

    await ctrl.getCompanyCard(req, 'co1', 'p1');
    await ctrl.getCompanyCard(req, 'co1', 'p1');

    expect(getCompany).toHaveBeenCalledTimes(2);
    expect(listContacts).toHaveBeenCalledTimes(1);
  });

  it('misses cache when cardContactsRev bumps', async () => {
    let rev = 1;
    const getCompany = jest.fn(() => of({ id: 'co1', name: 'Acme', card_contacts_rev: rev++ }));
    const listContacts = jest.fn(() => of({ list: [], total: 0 }));
    const listDeals = jest.fn(() => of({ list: [], total: 0 }));
    const listOrders = jest.fn(() => of({ list: [], total: 0 }));
    const listActivities = jest.fn(() => of({ list: [] }));
    const listEvents = jest.fn(() => of({ list: [] }));
    const ctrl = build({
      company: { getCompany },
      contact: { listContacts },
      pipe: { listDeals },
      orders: { listOrders },
      activity: { listActivities },
      audit: { listEvents },
    });

    await ctrl.getCompanyCard(req, 'co1', 'p1');
    await ctrl.getCompanyCard(req, 'co1', 'p1');

    expect(listContacts).toHaveBeenCalledTimes(2);
  });
});
