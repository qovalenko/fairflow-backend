import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Org seats / licenses (organization-module TZ §4.7, FR-MORG-22/23/24).
 *
 * box (on-prem, 03-ARCHITECTURE.md §6): single-tenant with no billing plane —
 * seats are unlimited and growth is never blocked. `used` is still surfaced (the
 * active-employee count) so the org UI can show headcount, but there is no quota,
 * no 402 path and no billing gRPC.
 *
 * `used` = COUNT(Employee WHERE organizationId=? AND isActive=true) — a freed
 *          (deactivated) employee no longer consumes a seat, no separate counter.
 */
export interface OrgSeats {
  used: number;
  total: number;
  overLimit: boolean;
  plan: string;
}

@Injectable()
export class SeatsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active-employee count is the seat usage. */
  async countActive(organizationId: string): Promise<number> {
    return this.prisma.employee.count({
      where: { organizationId, isActive: true },
    });
  }

  /** box: unlimited seats, never over limit (§6). */
  async getSeats(organizationId: string): Promise<OrgSeats> {
    return {
      used: await this.countActive(organizationId),
      total: Number.MAX_SAFE_INTEGER,
      overLimit: false,
      plan: 'box',
    };
  }

  /** No seat cache in box — kept for call-site parity with the SaaS build. */
  invalidate(_organizationId: string): void {}

  /** box: no seat limits — growth is always allowed (§6). */
  async assertSeatAvailable(
    _organizationId: string,
    _countActiveSeats: () => Promise<number>,
  ): Promise<void> {}
}
