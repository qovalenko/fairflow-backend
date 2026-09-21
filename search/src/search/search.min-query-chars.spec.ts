/**
 * TODO-492 / FR-SEARCH-020 — domain must honour gateway-resolved minQueryChars,
 * not only the hard floor of 2.
 */
import { SearchService } from './search.service';
import { buildMongo, row } from './fake-mongo.testkit';
import type { VisibilityScope } from '@fairflow/shared';

const PID = 'proj-1';
const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

const ctx = { ctx: { scope: ALL_SCOPE } } as const;

describe('SearchService minQueryChars (TODO-492)', () => {
  it('returns empty below the resolved threshold without scanning matches', async () => {
    const { mongo } = buildMongo({
      index: [
        row('c1', {
          projectId: PID,
          entityType: 'contact',
          entityId: 'c1',
          title: 'Акме',
          subtitle: '',
          tokens: 'акме',
          deletedAt: null,
          updatedAt: 1,
        }),
      ],
      state: [row('st1', { projectId: PID, backfilledAt: Date.now() })],
    });
    const svc = new SearchService(mongo as never);

    const below = await svc.search(PID, 'акм', 0, 25, { minQueryChars: 4, ...ctx });
    expect(below.total).toBe(0);
    expect(below.groups).toEqual([]);

    const ok = await svc.search(PID, 'акме', 0, 25, { minQueryChars: 4, ...ctx });
    expect(ok.total).toBeGreaterThan(0);
  });

  it('keeps the floor of 2 when minQueryChars is absent', async () => {
    const { mongo } = buildMongo({
      index: [
        row('c1', {
          projectId: PID,
          entityType: 'contact',
          entityId: 'c1',
          title: 'Ак',
          subtitle: '',
          tokens: 'ак',
          deletedAt: null,
          updatedAt: 1,
        }),
      ],
      state: [row('st1', { projectId: PID, backfilledAt: Date.now() })],
    });
    const svc = new SearchService(mongo as never);

    const oneChar = await svc.search(PID, 'а', 0, 25, ctx);
    expect(oneChar.total).toBe(0);

    const twoChars = await svc.search(PID, 'ак', 0, 25, ctx);
    expect(twoChars.total).toBeGreaterThan(0);
  });
});
