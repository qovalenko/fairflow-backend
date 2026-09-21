import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  BoxGatewayClient,
  BoxMongoReader,
  createLocalContactGrpcClient,
  describeBoxIntegration,
  readDriftDetailEntry,
  startLocalContactService,
  stopLocalContactService,
  uniqueBoxName,
  waitFor,
  type ContactGrpcClient,
} from '@fairflow/testing';

/**
 * Integration closure wave — group merge (#51–#58).
 *
 * Local: contact gRPC (+ its Rabbit consumers on the box stand bus).
 * Peers on the box stand: company, pipe, activity, search, orders (peer gRPC на the box stand).
 *
 * Data isolation: каждый тест создаёт свой проект через control gRPC; мутации только внутри него.
 * Requires: BOX_INTEGRATION=1, network reachability to the box stand, built contact dist + @fairflow/testing.
 */

jest.setTimeout(600_000);

const MERGE_MODULES = ['contacts', 'companies', 'deals', 'orders', 'activities'];

describeBoxIntegration('group-merge the box stand (contact local, peers on the box stand)', () => {
  let gateway: BoxGatewayClient;
  let contact: ContactGrpcClient;
  let mongo: BoxMongoReader;
  let projectId: string;
  const mdCtx = () => ({ projectId, userId: gateway.userId });

  beforeAll(async () => {
    await startLocalContactService();
    gateway = await BoxGatewayClient.login();
    contact = createLocalContactGrpcClient();
    mongo = await BoxMongoReader.connect();
  }, 180_000);

  afterAll(async () => {
    contact.close();
    await stopLocalContactService();
    await mongo.close();
  });

  beforeEach(async () => {
    projectId = await gateway.createProject(uniqueBoxName('merge'), MERGE_MODULES);
  });

  afterEach(async () => {
    await gateway.archiveProject(projectId);
  });

  // ── #51 contact → company GetCompany on create/update ─────────────────────
  it('#51: contact validates company via GetCompany on create', async () => {
    const companyId = await gateway.createCompany(projectId, {
      name: uniqueBoxName('co-valid'),
      inn: '7700000099',
    });

    const created = await contact.createContact(
      {
        first_name: 'Valid',
        last_name: 'Link',
        email: `${uniqueBoxName('valid')}@example.com`,
        company_ids: [companyId],
      },
      mdCtx(),
    );
    expect(created.company_ids).toEqual([companyId]);
  });

  it('#51: contact rejects missing company with INVALID_ARGUMENT on create', async () => {
    await expect(
      contact.createContact(
        {
          first_name: 'Bad',
          last_name: 'Link',
          email: `${uniqueBoxName('bad')}@example.com`,
          company_ids: ['bbbbbbbbbbbbbbbbbbbbbbbb'],
        },
        mdCtx(),
      ),
    ).rejects.toMatchObject({ code: GrpcStatus.INVALID_ARGUMENT });
  });

  it('#51: contact validates company via GetCompany on update', async () => {
    const companyId = await gateway.createCompany(projectId, {
      name: uniqueBoxName('co-upd'),
      inn: '7700000100',
    });
    const row = await contact.createContact(
      {
        first_name: 'Upd',
        last_name: 'Base',
        email: `${uniqueBoxName('upd')}@example.com`,
      },
      mdCtx(),
    );

    const updated = await contact.updateContact(
      { id: row.id, company_ids: [companyId], set_company_ids: true },
      mdCtx(),
    );
    expect(updated.company_ids).toEqual([companyId]);
  });

  // ── #56 delta projection into search (contact / company / deal / order) ─────
  it('#56: contact/company/deal/order events project into search_index', async () => {
    const companyId = await gateway.createCompany(projectId, {
      name: uniqueBoxName('Search Co'),
      inn: '7700000104',
    });

    await waitFor(
      async () => {
        const doc = await mongo.findSearchDoc(projectId, 'company', companyId);
        return doc?.title ? doc : false;
      },
      { label: 'search_index company projection', timeoutMs: 120_000 },
    );

    const ct = await contact.createContact(
      {
        first_name: 'Search',
        last_name: 'Contact',
        email: `${uniqueBoxName('search')}@example.com`,
      },
      mdCtx(),
    );
    const contactId = String(ct.id);

    await waitFor(
      async () => {
        const doc = await mongo.findSearchDoc(projectId, 'contact', contactId);
        return doc?.title === 'Search Contact' ? doc : false;
      },
      { label: 'search_index contact projection', timeoutMs: 120_000 },
    );

    const dealName = uniqueBoxName('Search Deal');
    const dealId = await gateway.createDeal(projectId, {
      name: dealName,
      contactId,
    });
    await waitFor(
      async () => {
        const doc = await mongo.findSearchDoc(projectId, 'deal', dealId);
        return doc?.entityId === dealId || doc?.title === dealName ? doc : false;
      },
      { label: 'search_index deal projection', timeoutMs: 120_000 },
    );

    const orderId = await gateway.createOrder(projectId, {
      name: uniqueBoxName('Search Order'),
      orderTypeName: uniqueBoxName('ord-type'),
      stageId: 's1',
    });
    await waitFor(
      async () => {
        const doc = await mongo.findSearchDoc(projectId, 'order', orderId);
        return doc?.entityId === orderId ? doc : false;
      },
      { label: 'search_index order projection', timeoutMs: 180_000 },
    );
  });

  // ── #58 activity → search crm.activity.created ──────────────────────────
  it('#58: crm.activity.created projects activity into search_index', async () => {
    const title = uniqueBoxName('Search Act');
    const activityId = await gateway.createActivity(projectId, { title });

    const doc = await waitFor(
      async () => {
        const row = await mongo.findSearchDoc(projectId, 'activity', activityId);
        return row?.title === title ? row : false;
      },
      { label: 'search_index activity projection', timeoutMs: 120_000 },
    );
    expect(doc?.entityType).toBe('activity');
  });

  // ── #52 company.deleted → contact orphanedCompanyIds ───────────────────────
  it('#52: company.deleted marks orphanedCompanyIds on linked contacts', async () => {
    const companyId = await gateway.createCompany(projectId, {
      name: uniqueBoxName('co-del'),
      inn: '7700000101',
    });
    const created = await contact.createContact(
      {
        first_name: 'Orphan',
        last_name: 'Test',
        email: `${uniqueBoxName('orphan')}@example.com`,
        company_ids: [companyId],
      },
      mdCtx(),
    );

    await gateway.deleteCompany(projectId, companyId);

    const stored = await waitFor(
      async () => {
        const doc = await mongo.findContact(projectId, String(created.id));
        const orphaned = (doc?.orphanedCompanyIds as string[] | undefined) ?? [];
        return orphaned.includes(companyId) ? doc : false;
      },
      { label: 'orphanedCompanyIds after company.deleted', timeoutMs: 120_000 },
    );
    expect(stored?.orphanedCompanyIds).toEqual(expect.arrayContaining([companyId]));
    expect(stored?.companyIds ?? []).not.toContain(companyId);
  });

  // ── #52 company.deleted → pipe companySourceDeleted ───────────────────────
  it('#52: company.deleted sets companySourceDeleted on pipe deals', async () => {
    const companyId = await gateway.createCompany(projectId, {
      name: uniqueBoxName('co-pipe-del'),
      inn: '7700000102',
    });
    const dealId = await gateway.createDeal(projectId, {
      name: uniqueBoxName('deal-co-del'),
      companyId,
    });

    await gateway.deleteCompany(projectId, companyId);

    const deal = await waitFor(
      async () => {
        const doc = await mongo.findDeal(projectId, dealId);
        return doc?.companySourceDeleted === true ? doc : false;
      },
      { label: 'companySourceDeleted on deal', timeoutMs: 120_000 },
    );
    expect(deal?.companySourceDeleted).toBe(true);
  });

  // ── #53 contact.deleted → pipe contactSourceDeleted ───────────────────────
  it('#53: contact.deleted sets contactSourceDeleted on pipe deals', async () => {
    const created = await contact.createContact(
      {
        first_name: 'Del',
        last_name: 'Source',
        email: `${uniqueBoxName('del-src')}@example.com`,
        phone: '+79001112233',
      },
      mdCtx(),
    );
    const contactId = String(created.id);
    const dealId = await gateway.createDeal(projectId, {
      name: uniqueBoxName('deal-ct-del'),
      contactId,
    });

    await contact.deleteContact({ id: contactId }, mdCtx());

    const deal = await waitFor(
      async () => {
        const doc = await mongo.findDeal(projectId, dealId);
        return doc?.contactSourceDeleted === true ? doc : false;
      },
      { label: 'contactSourceDeleted on deal', timeoutMs: 120_000 },
    );
    expect(deal?.contactSourceDeleted).toBe(true);
  });

  // ── #54 crm.contact.updated / crm.company.updated → pipe drift ─────────────
  it('#54: crm.contact.updated triggers pipe drift on deal snapshot', async () => {
    const created = await contact.createContact(
      {
        first_name: 'Drift',
        last_name: 'Before',
        email: `${uniqueBoxName('drift')}@example.com`,
        phone: '+79002223344',
      },
      mdCtx(),
    );
    const contactId = String(created.id);
    const dealId = await gateway.createDeal(projectId, {
      name: uniqueBoxName('deal-drift'),
    });
    await gateway.linkDealContact(projectId, dealId, contactId, {
      name: 'Drift Before',
      phone: '+79002223344',
      email: String(created.email ?? ''),
    });

    await contact.updateContact(
      { id: contactId, first_name: 'Drift', last_name: 'After' },
      mdCtx(),
    );

    const deal = await waitFor(
      async () => {
        const doc = await mongo.findDeal(projectId, dealId);
        const drift = doc?.driftDetail as Record<string, unknown> | undefined;
        const nameDrift = readDriftDetailEntry(drift, 'name');
        return nameDrift?.currentValue === 'Drift After' ? doc : false;
      },
      { label: 'contact drift on deal after crm.contact.updated', timeoutMs: 120_000 },
    );
    expect(deal?.contactId).toBe(contactId);
  });

  it('#54: crm.company.updated triggers pipe drift on deal company snapshot', async () => {
    const coBefore = uniqueBoxName('Co Before');
    const coAfter = uniqueBoxName('Co After');
    const companyId = await gateway.createCompany(projectId, {
      name: coBefore,
      inn: '7700000103',
    });
    const dealId = await gateway.createDeal(projectId, {
      name: uniqueBoxName('deal-co-drift'),
    });
    await gateway.linkDealCompany(projectId, dealId, companyId, {
      name: coBefore,
      inn: '7700000103',
    });

    await gateway.updateCompany(projectId, companyId, { name: coAfter });

    const deal = await waitFor(
      async () => {
        const doc = await mongo.findDeal(projectId, dealId);
        const drift = doc?.driftDetail as Record<string, unknown> | undefined;
        const companyDrift = readDriftDetailEntry(drift, 'company.name');
        const current = String(companyDrift?.currentValue ?? '');
        return current.includes(coAfter) ? doc : false;
      },
      { label: 'company drift on deal after crm.company.updated', timeoutMs: 120_000 },
    );
    expect(deal?.companyId).toBe(companyId);
  });

  // ── #55 crm.contact.merged → activity rewrite links ───────────────────────
  it('#55: crm.contact.merged rewrites activity contact links to survivor', async () => {
    const source = await contact.createContact(
      {
        first_name: 'Merge',
        last_name: 'Source',
        email: `${uniqueBoxName('m-src')}@example.com`,
      },
      mdCtx(),
    );
    const target = await contact.createContact(
      {
        first_name: 'Merge',
        last_name: 'Target',
        email: `${uniqueBoxName('m-tgt')}@example.com`,
      },
      mdCtx(),
    );
    const sourceId = String(source.id);
    const targetId = String(target.id);

    const activityId = await gateway.createActivity(projectId, {
      title: uniqueBoxName('act-merge'),
      links: [{ entityType: 'contact', entityId: sourceId }],
    });

    await contact.mergeContacts({ source_id: sourceId, target_id: targetId }, mdCtx());

    const activity = await waitFor(
      async () => {
        const doc = await mongo.findActivity(projectId, activityId);
        const links = (doc?.links as Array<{ entityType: string; entityId: string }>) ?? [];
        const contactLink = links.find((l) => l.entityType === 'contact');
        return contactLink?.entityId === targetId ? doc : false;
      },
      { label: 'activity link rewritten after contact.merged', timeoutMs: 120_000 },
    );
    expect(activity?.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: 'contact', entityId: targetId }),
      ]),
    );
  });

  // ── #57 activity → {contact,company,pipe,orders} Get* for nameSnapshot ─────
  it('#57: activity resolves nameSnapshot via peer Get* gRPC', async () => {
    const companyId = await gateway.createCompany(projectId, {
      name: uniqueBoxName('Snap Co'),
      inn: '7700000105',
    });
    const ct = await contact.createContact(
      {
        first_name: 'Snap',
        last_name: 'Shot',
        email: `${uniqueBoxName('snap')}@example.com`,
        company_ids: [companyId],
      },
      mdCtx(),
    );
    const contactId = String(ct.id);
    const dealId = await gateway.createDeal(projectId, {
      name: uniqueBoxName('Snap Deal'),
      contactId,
      companyId,
    });

    const activityId = await gateway.createActivity(projectId, {
      title: uniqueBoxName('snap-links'),
      links: [
        { entityType: 'contact', entityId: contactId },
        { entityType: 'company', entityId: companyId },
        { entityType: 'deal', entityId: dealId },
      ],
    });

    const activity = await waitFor(
      async () => {
        const doc = await mongo.findActivity(projectId, activityId);
        const links = (doc?.links as Array<{ entityType: string; nameSnapshot?: string }>) ?? [];
        const contactLink = links.find((l) => l.entityType === 'contact');
        const companyLink = links.find((l) => l.entityType === 'company');
        const dealLink = links.find((l) => l.entityType === 'deal');
        if (
          contactLink?.nameSnapshot?.includes('Snap') &&
          companyLink?.nameSnapshot &&
          dealLink?.nameSnapshot
        ) {
          return doc;
        }
        return false;
      },
      { label: 'activity link nameSnapshots resolved', timeoutMs: 120_000 },
    );
    const links = (activity?.links as Array<{ entityType: string; nameSnapshot?: string }>) ?? [];
    expect(links.find((l) => l.entityType === 'contact')?.nameSnapshot).toContain('Snap');
  });
});
