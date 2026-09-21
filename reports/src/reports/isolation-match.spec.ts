import { ReportsService } from './reports.service';

/**
 * andMatch (tenant-isolation regression, T-012). The dashboard/statistics
 * aggregations previously composed the project filter, the visibility predicate
 * and the date window by object spread. Because the project filter is
 * `{$or:[{projectId},{project_id}]}` and both the date window and the
 * own_and_shared visibility predicate are ALSO `$or`, spreading silently dropped
 * the project scope (the second `$or` overwrote the first) — aggregates then
 * leaked across projects. andMatch composes fragments with `$and`, preserving
 * every fragment. Pure (no Mongo/gRPC touched), so deps are stubbed.
 */
describe('ReportsService.andMatch (project isolation)', () => {
  const svc = new ReportsService({} as never, {} as never, {} as never, {} as never, { read: async () => [] } as never, { get: async () => null, isTrusted: () => false } as never, { listForDeal: async () => [], avgDurationByStage: async () => [] } as never);
  const andMatch = (...frags: (Record<string, unknown> | null | undefined)[]): Record<string, unknown> =>
    (
      svc as unknown as {
        andMatch(...f: (Record<string, unknown> | null | undefined)[]): Record<string, unknown>;
      }
    ).andMatch(...frags);

  const projectFilter = { $or: [{ projectId: 'p1' }, { project_id: 'p1' }] };
  const dateFilter = { $or: [{ createdAt: { $gte: 1, $lte: 2 } }, { created_at: { $gte: 1, $lte: 2 } }] };

  it('keeps BOTH $or fragments under $and (project scope survives the date window)', () => {
    const m = andMatch(projectFilter, dateFilter);
    expect(m).toEqual({ $and: [projectFilter, dateFilter] });
    // Regression guard: a naive spread would collapse to just the date $or.
    expect(m).not.toEqual(dateFilter);
  });

  it('preserves the project $or alongside an own_and_shared visibility $or', () => {
    const visFilter = { $or: [{ assigneeId: { $in: ['u1'] } }, { _id: { $in: ['x'] } }] };
    const m = andMatch(projectFilter, visFilter);
    expect(m).toEqual({ $and: [projectFilter, visFilter] });
  });

  it('ignores null/undefined/empty fragments (mode "all" visibility)', () => {
    expect(andMatch(projectFilter, null)).toEqual(projectFilter);
    expect(andMatch(projectFilter, undefined, {})).toEqual(projectFilter);
  });

  it('returns {} when there is nothing to match', () => {
    expect(andMatch(null, undefined, {})).toEqual({});
  });

  it('combines three $or/scalar fragments (project + visibility + date)', () => {
    const visFilter = { assigneeId: { $in: ['u1'] } };
    const m = andMatch(projectFilter, visFilter, dateFilter);
    expect(m).toEqual({ $and: [projectFilter, visFilter, dateFilter] });
  });
});
