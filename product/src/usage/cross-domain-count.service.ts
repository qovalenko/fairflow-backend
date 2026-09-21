import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';
import { GW_METADATA, newEntityId } from '@fairflow/shared';

interface PipeCountSvc {
  countDealsByProduct: (
    d: { project_id: string; product_id: string },
    metadata?: Metadata,
  ) => Observable<{ count?: number; active_count?: number }>;
}
interface OrdersCountSvc {
  countOrdersByProduct: (
    d: { project_id: string; product_id: string },
    metadata?: Metadata,
  ) => Observable<{ count?: number }>;
}

/**
 * Cross-domain read-only count client (contract §3.10) used by RecountProductUsage.
 *
 * Calls `pipe.CountDealsByProduct` + `orders.CountOrdersByProduct` with a
 * service-to-service metadata envelope (x-service-api-key + propagated context),
 * passing `project_id` so the counts are scoped to this tenant (S7 — a foreign
 * projectId can never count another project's deals/orders). Best-effort: a
 * broker/RPC failure degrades to the last known value rather than corrupting it.
 */
@Injectable()
export class CrossDomainCountService implements OnModuleInit {
  private readonly logger = new Logger(CrossDomainCountService.name);
  private pipe!: PipeCountSvc;
  private orders!: OrdersCountSvc;
  private readonly apiKey =
    process.env.PRODUCT_SERVICE_API_KEY ?? process.env.GATEWAY_SERVICE_API_KEY ?? '';

  constructor(
    @Inject('PIPE_GRPC') private readonly pipeClient: ClientGrpcProxy,
    @Inject('ORDERS_GRPC') private readonly ordersClient: ClientGrpcProxy,
  ) {}

  onModuleInit(): void {
    this.pipe = this.pipeClient.getService<PipeCountSvc>('PipeGrpc');
    this.orders = this.ordersClient.getService<OrdersCountSvc>('OrdersGrpc');
  }

  /** s2s metadata accepted by the pipe/orders inbound api-key guard. */
  private meta(projectId: string): Metadata {
    const m = new Metadata();
    if (this.apiKey) m.set(GW_METADATA.SERVICE_API_KEY, this.apiKey);
    m.set(GW_METADATA.REQUEST_ID, newEntityId());
    m.set(GW_METADATA.TRACE_ID, newEntityId());
    m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
    m.set(GW_METADATA.ACTOR_TYPE, 'service');
    m.set(GW_METADATA.PROJECT_ID, projectId);
    return m;
  }

  async countDeals(
    projectId: string,
    productId: string,
  ): Promise<{ deals: number; activeDeals: number } | null> {
    try {
      const r = await firstValueFrom(
        this.pipe.countDealsByProduct(
          { project_id: projectId, product_id: productId },
          this.meta(projectId),
        ),
      );
      return { deals: Number(r.count ?? 0), activeDeals: Number(r.active_count ?? 0) };
    } catch (err) {
      this.logger.warn(`pipe.CountDealsByProduct failed for ${productId}: ${String(err)}`);
      return null;
    }
  }

  async countOrders(projectId: string, productId: string): Promise<number | null> {
    try {
      const r = await firstValueFrom(
        this.orders.countOrdersByProduct(
          { project_id: projectId, product_id: productId },
          this.meta(projectId),
        ),
      );
      return Number(r.count ?? 0);
    } catch (err) {
      this.logger.warn(`orders.CountOrdersByProduct failed for ${productId}: ${String(err)}`);
      return null;
    }
  }
}
