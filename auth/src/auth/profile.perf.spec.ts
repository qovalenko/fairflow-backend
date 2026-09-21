import { performance } from 'node:perf_hooks';
import { ProfileService } from './profile.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtService } from '@nestjs/jwt';
import type { ProfileEventsService } from './profile-events.service';
import { Require2faPolicyService } from './require2fa-policy.service';

/** NFR-030 (35-profile.md): p95 < 200 ms for sessions / foreign profile — local budget with mocked Prisma. */
describe('ProfileService perf (NFR-030)', () => {
  const ITER = 200;
  const P95_BUDGET_MS = 200;

  function p95(samples: number[]): number {
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[idx] ?? 0;
  }

  function makeService(sessionRows: unknown[], lastActiveAt: Date | null) {
    const session = {
      findMany: jest.fn().mockResolvedValue(sessionRows),
      aggregate: jest.fn().mockResolvedValue({ _max: { lastSeenAt: lastActiveAt } }),
    };
    const user = {
      findFirst: jest.fn().mockResolvedValue({
        id: 't1',
        login: 'target',
        email: 't@example.com',
        name: 'Target User',
        avatarUrl: '',
        phone: '+1',
        position: 'Mgr',
        language: 'ru',
        timezone: 'Europe/Moscow',
        dateFormat: 'DD.MM.YYYY',
        timeFormat: '24h',
        thousandsSeparator: 'space',
        defaultDealsView: 'kanban',
        defaultActivitiesView: 'list',
      }),
    };
    const prisma = { session, user } as unknown as PrismaService;
    const jwt = { sign: jest.fn(), verify: jest.fn() } as unknown as JwtService;
    const events = {} as unknown as ProfileEventsService;
    const denyPush = {
      pushDenied: jest.fn(),
      pushDeniedMany: jest.fn(),
    };
    const service = new ProfileService(
      prisma,
      jwt,
      events,
      denyPush as never,
      new Require2faPolicyService(),
    );
    return { service, session, user };
  }

  it('listSessions stays within p95 budget (single query, no N+1)', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      tokenId: i === 0 ? 'cur' : `tok-${i}`,
      deviceLabel: 'Chrome',
      ip: '127.0.0.1',
      lastSeenAt: new Date('2026-08-19T10:00:00.000Z'),
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    }));
    const { service, session } = makeService(rows, null);
    const samples: number[] = [];

    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      await service.listSessions('u1', 'cur');
      samples.push(performance.now() - t0);
    }

    const p95ms = p95(samples);
    expect(session.findMany).toHaveBeenCalledTimes(ITER);
    expect(p95ms).toBeLessThan(P95_BUDGET_MS);
  });

  it('getUserProfileForViewer stays within p95 budget (bounded queries)', async () => {
    const { service, user, session } = makeService([], new Date('2026-08-19T09:00:00.000Z'));
    const samples: number[] = [];

    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      await service.getUserProfileForViewer('t1', {
        projectRole: 'admin',
        projectId: 'p1',
      });
      samples.push(performance.now() - t0);
    }

    const p95ms = p95(samples);
    expect(user.findFirst).toHaveBeenCalledTimes(ITER);
    expect(session.aggregate).toHaveBeenCalledTimes(ITER);
    expect(p95ms).toBeLessThan(P95_BUDGET_MS);
  });
});
