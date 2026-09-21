import { Injectable, Logger } from '@nestjs/common';
import { CrossDomainCountService } from './cross-domain-count.service';
import { ProductService } from '../product/product.service';

/**
 * Reconciliation orchestrator for RecountProductUsage (contract §3.10, board C4).
 *
 * Pulls the authoritative deal/order counts from pipe/orders (cross-domain count
 * RPCs, projectId-scoped — IDOR-safe) and writes them onto the product document,
 * repairing any drift the eventual listener counters accumulated. When `productId`
 * is empty every product of the project is reconciled (backfill).
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly counts: CrossDomainCountService,
    private readonly product: ProductService,
  ) {}

  async recount(
    projectId: string,
    productId?: string,
  ): Promise<{ recounted: number; skipped: number }> {
    const ids = productId ? [productId] : await this.product.listProductIds(projectId);
    let recounted = 0;
    let skipped = 0;
    for (const id of ids) {
      const deals = await this.counts.countDeals(projectId, id);
      const orders = await this.counts.countOrders(projectId, id);
      // Частичная сверка (TODO-229): пишем ТОЛЬКО те счётчики, чей источник
      // ответил. Раньше пропуск стоял лишь при падении ОБОИХ доменов, а дальше
      // шла безусловная запись `deals?.deals ?? 0` / `orders ?? 0` — лежащий
      // pipe обнулял dealsCount/activeDealsCount, лежащий orders — ordersCount.
      const counts: { deals?: number; activeDeals?: number; orders?: number } = {};
      if (deals != null) {
        counts.deals = deals.deals;
        counts.activeDeals = deals.activeDeals;
      }
      if (orders != null) counts.orders = orders;
      // Продукт считается сверенным только при ПОЛНОМ успехе; всё остальное
      // (частичная запись или ни одного ответа) уходит в skipped — вызывающий
      // видит, что сверка неполная, и может повторить её позже.
      if (deals == null || orders == null) skipped += 1;
      if (Object.keys(counts).length === 0) continue;
      await this.product.recountUsage(projectId, id, counts);
      if (deals != null && orders != null) recounted += 1;
    }
    this.logger.log(
      `recounted ${recounted}/${ids.length} product(s) (skipped ${skipped}) for project ${projectId}`,
    );
    return { recounted, skipped };
  }
}
