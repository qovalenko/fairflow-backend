import { BillingGrpcController } from './billing.grpc.controller';
import { BillingService } from './billing.service';
import { ModuleSubscriptionService } from './module-subscription.service';

function buildController(
  billing: Partial<BillingService> = {},
  modules: Partial<ModuleSubscriptionService> = {},
) {
  return new BillingGrpcController(billing as BillingService, modules as ModuleSubscriptionService);
}

describe('BillingGrpcController', () => {
  it('GetPlan forwards snake_case wire fields to BillingService', async () => {
    const getPlan = jest.fn().mockResolvedValue({ id: 'plan-1' });
    const ctl = buildController({ getPlan });
    await ctl.getPlan({ plan_id: 'plan-1', plan_code: 'pro' });
    expect(getPlan).toHaveBeenCalledWith('plan-1', 'pro');
  });

  it('ListPlans passes include_inactive flag', async () => {
    const listPlans = jest.fn().mockResolvedValue({ list: [] });
    const ctl = buildController({ listPlans });
    await ctl.listPlans({ include_inactive: true });
    expect(listPlans).toHaveBeenCalledWith(true);
  });

  it('Subscribe forwards project_id and plan_id', async () => {
    const subscribe = jest.fn().mockResolvedValue({ subscription: { id: 'sub-1' } });
    const ctl = buildController({ subscribe });
    await ctl.subscribe({ project_id: 'p-1', plan_id: 'plan-1' });
    expect(subscribe).toHaveBeenCalledWith('p-1', 'plan-1');
  });

  it('ListPayments / ListInvoices default pagination', async () => {
    const listPayments = jest.fn().mockResolvedValue({ list: [], total: 0 });
    const listInvoices = jest.fn().mockResolvedValue({ list: [], total: 0 });
    const ctl = buildController({ listPayments, listInvoices });
    await ctl.listPayments({ project_id: 'p-1' });
    await ctl.listInvoices({ project_id: 'p-1', page_index: 2, page_size: 10 });
    expect(listPayments).toHaveBeenCalledWith('p-1', 0, 25);
    expect(listInvoices).toHaveBeenCalledWith('p-1', 2, 10);
  });

  it('CheckQuota forwards project_id and action', async () => {
    const checkQuota = jest.fn().mockResolvedValue({ allowed: true });
    const ctl = buildController({ checkQuota });
    await ctl.checkQuota({ project_id: 'p-1', action: 'contacts.read' });
    expect(checkQuota).toHaveBeenCalledWith('p-1', 'contacts.read');
  });

  it('read-side snapshot/usage/org-seat methods delegate to BillingService', async () => {
    const getSubscriptionSnapshot = jest.fn().mockResolvedValue({ state: 'active' });
    const getUsage = jest.fn().mockResolvedValue({ quotas: [] });
    const getOrgSeatQuota = jest.fn().mockResolvedValue({ total: 10 });
    const ctl = buildController({ getSubscriptionSnapshot, getUsage, getOrgSeatQuota });
    await ctl.getSubscriptionSnapshot({ project_id: 'p-1', owner: 'org-1' });
    await ctl.getUsage({ project_id: 'p-1' });
    await ctl.getOrgSeatQuota({ organization_id: 'org-1' });
    expect(getSubscriptionSnapshot).toHaveBeenCalledWith('p-1', 'org-1');
    expect(getUsage).toHaveBeenCalledWith('p-1');
    expect(getOrgSeatQuota).toHaveBeenCalledWith('org-1');
  });

  it('module subscription gRPC methods map wire fields to ModuleSubscriptionService', async () => {
    const subscribeModule = jest.fn().mockResolvedValue({ subscription: {} });
    const unsubscribeModule = jest.fn().mockResolvedValue({ state: 'cancelled' });
    const getModuleSubscriptions = jest.fn().mockResolvedValue({ list: [] });
    const checkModuleEntitlement = jest.fn().mockResolvedValue({ allow_enable: true });
    const incrementUsage = jest.fn().mockResolvedValue({ ok: true });
    const listAccountStateChanges = jest.fn().mockResolvedValue({ list: [], total: 0 });
    const ctl = buildController(
      {},
      {
        subscribeModule,
        unsubscribeModule,
        getModuleSubscriptions,
        checkModuleEntitlement,
        incrementUsage,
        listAccountStateChanges,
      },
    );

    await ctl.subscribeModule({
      project_id: 'p-1',
      module_id: 'documents',
      price_model: 'flat',
      unit_price_minor: 100,
      currency: 'RUB',
      revenue_share_bps: 500,
      trial_days: 7,
      partner_id: 'partner-1',
    });
    expect(subscribeModule).toHaveBeenCalledWith({
      projectId: 'p-1',
      moduleId: 'documents',
      priceModel: 'flat',
      unitPriceMinor: 100,
      currency: 'RUB',
      revenueShareBps: 500,
      trialDays: 7,
      partnerId: 'partner-1',
    });

    await ctl.unsubscribeModule({ project_id: 'p-1', module_id: 'documents' });
    expect(unsubscribeModule).toHaveBeenCalledWith({ projectId: 'p-1', moduleId: 'documents' });

    await ctl.getModuleSubscriptions({ project_id: 'p-1' });
    expect(getModuleSubscriptions).toHaveBeenCalledWith('p-1');

    await ctl.checkModuleEntitlement({ project_id: 'p-1', module_id: 'documents' });
    expect(checkModuleEntitlement).toHaveBeenCalledWith({
      projectId: 'p-1',
      moduleId: 'documents',
    });

    await ctl.incrementUsage({
      project_id: 'p-1',
      module: 'documents',
      metric: 'documents.generate',
      delta: 2,
      message_id: 'msg-1',
    });
    expect(incrementUsage).toHaveBeenCalledWith({
      projectId: 'p-1',
      module: 'documents',
      metric: 'documents.generate',
      delta: 2,
      messageId: 'msg-1',
    });

    await ctl.listAccountStateChanges({ project_id: 'p-1', page_index: 1, page_size: 50 });
    expect(listAccountStateChanges).toHaveBeenCalledWith('p-1', 1, 50);
  });
});
