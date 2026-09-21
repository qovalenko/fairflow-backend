import { RequireModule } from '@fairflow/shared';
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { BillingService } from './billing.service';
import { ModuleSubscriptionService } from './module-subscription.service';

@Controller()
@RequireModule('billing')
export class BillingGrpcController {
  constructor(
    private readonly billing: BillingService,
    private readonly modules: ModuleSubscriptionService,
  ) {}

  @GrpcMethod('BillingGrpc', 'GetPlan')
  getPlan(data: { plan_id?: string; plan_code?: string }) {
    return this.billing.getPlan(data.plan_id ?? '', data.plan_code ?? '');
  }

  @GrpcMethod('BillingGrpc', 'ListPlans')
  listPlans(data: { include_inactive?: boolean }) {
    return this.billing.listPlans(Boolean(data.include_inactive));
  }

  @GrpcMethod('BillingGrpc', 'Subscribe')
  subscribe(data: { project_id?: string; plan_id?: string }) {
    return this.billing.subscribe(data.project_id ?? '', data.plan_id ?? '');
  }

  @GrpcMethod('BillingGrpc', 'ListPayments')
  listPayments(data: { project_id?: string; page_index?: number; page_size?: number }) {
    return this.billing.listPayments(
      data.project_id ?? '',
      data.page_index ?? 0,
      data.page_size ?? 25,
    );
  }

  @GrpcMethod('BillingGrpc', 'ListInvoices')
  listInvoices(data: { project_id?: string; page_index?: number; page_size?: number }) {
    return this.billing.listInvoices(
      data.project_id ?? '',
      data.page_index ?? 0,
      data.page_size ?? 25,
    );
  }

  @GrpcMethod('BillingGrpc', 'CheckQuota')
  checkQuota(data: { project_id?: string; action?: string }) {
    return this.billing.checkQuota(data.project_id ?? '', data.action ?? '');
  }

  // ---- P2.e (be-billing-seats): read-side snapshot / usage / org-seat quota ----

  @GrpcMethod('BillingGrpc', 'GetSubscriptionSnapshot')
  getSubscriptionSnapshot(data: { project_id?: string; owner?: string }) {
    return this.billing.getSubscriptionSnapshot(data.project_id ?? '', data.owner ?? '');
  }

  @GrpcMethod('BillingGrpc', 'GetUsage')
  getUsage(data: { project_id?: string }) {
    return this.billing.getUsage(data.project_id ?? '');
  }

  @GrpcMethod('BillingGrpc', 'GetOrgSeatQuota')
  getOrgSeatQuota(data: { organization_id?: string }) {
    return this.billing.getOrgSeatQuota(data.organization_id ?? '');
  }

  // ---- I1a (E3-04): paid-module subscriptions & pay-gate ----

  @GrpcMethod('BillingGrpc', 'SubscribeModule')
  subscribeModule(data: {
    project_id?: string;
    module_id?: string;
    price_model?: string;
    unit_price_minor?: number;
    currency?: string;
    revenue_share_bps?: number;
    trial_days?: number;
    partner_id?: string;
  }) {
    return this.modules.subscribeModule({
      projectId: data.project_id ?? '',
      moduleId: data.module_id ?? '',
      priceModel: data.price_model,
      unitPriceMinor: data.unit_price_minor,
      currency: data.currency,
      revenueShareBps: data.revenue_share_bps,
      trialDays: data.trial_days,
      partnerId: data.partner_id,
    });
  }

  @GrpcMethod('BillingGrpc', 'UnsubscribeModule')
  unsubscribeModule(data: { project_id?: string; module_id?: string }) {
    return this.modules.unsubscribeModule({
      projectId: data.project_id ?? '',
      moduleId: data.module_id ?? '',
    });
  }

  @GrpcMethod('BillingGrpc', 'GetModuleSubscriptions')
  getModuleSubscriptions(data: { project_id?: string }) {
    return this.modules.getModuleSubscriptions(data.project_id ?? '');
  }

  @GrpcMethod('BillingGrpc', 'CheckModuleEntitlement')
  checkModuleEntitlement(data: { project_id?: string; module_id?: string }) {
    return this.modules.checkModuleEntitlement({
      projectId: data.project_id ?? '',
      moduleId: data.module_id ?? '',
    });
  }

  @GrpcMethod('BillingGrpc', 'IncrementUsage')
  incrementUsage(data: {
    project_id?: string;
    module?: string;
    metric?: string;
    delta?: number;
    message_id?: string;
  }) {
    return this.modules.incrementUsage({
      projectId: data.project_id ?? '',
      module: data.module ?? '',
      metric: data.metric ?? '',
      delta: data.delta ?? 0,
      messageId: data.message_id ?? '',
    });
  }

  @GrpcMethod('BillingGrpc', 'ListAccountStateChanges')
  listAccountStateChanges(data: { project_id?: string; page_index?: number; page_size?: number }) {
    return this.modules.listAccountStateChanges(
      data.project_id ?? '',
      data.page_index ?? 0,
      data.page_size ?? 25,
    );
  }
}
