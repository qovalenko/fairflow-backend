import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';

type Rec = Record<string, unknown>;

const SCOPE_MEMBER: VisibilityScope = {
  mode: 'restricted',
  level: 'only_own',
  selfId: 'u-member',
  ownerIds: ['u-member'],
  sharedRecordIds: [],
} as VisibilityScope;

describe('ReportsService visibility isolation (NFR-REPORTS-070)', () => {
  const svc = new ReportsService({} as never, {} as never, {} as never, {} as never, { read: async () => [] } as never, { get: async () => null, isTrusted: () => false } as never, { listForDeal: async () => [], avgDurationByStage: async () => [] } as never);

  const visMatch = (entity: string, scope: VisibilityScope): Rec | null =>
    (
      svc as unknown as {
        visMatch(e: string, s: VisibilityScope): Rec | null;
      }
    ).visMatch(entity, scope);

  const projectFilter = (projectId: string): Rec =>
    (
      svc as unknown as {
        projectFilter(p: string): Rec;
      }
    ).projectFilter(projectId);

  it('visMatch Member ограничивает deals ownerId assigneeId', () => {
    const m = visMatch('deals', SCOPE_MEMBER);
    expect(JSON.stringify(m)).toContain('u-member');
    expect(JSON.stringify(m)).not.toContain('u-stranger');
  });

  it('sourceMatch включает project $or и visMatch (run/export/drill)', () => {
    const match = (
      svc as unknown as {
        sourceMatch(
          e: string,
          p: string,
          s: VisibilityScope,
          params: Rec,
        ): Rec;
      }
    ).sourceMatch('deals', 'p1', SCOPE_MEMBER, {});
    const blob = JSON.stringify(match);
    expect(blob).toContain('projectId');
    expect(blob).toContain('u-member');
    expect(blob).not.toContain('u-stranger');
  });

  it('visMatch Member не пропускает чужой ownerId в предикат', () => {
    const m = visMatch('deals', SCOPE_MEMBER);
    const blob = JSON.stringify(m);
    expect(blob).toContain('u-member');
    expect(blob).not.toMatch(/u-other|u-stranger|u-admin/);
  });

  it('projectFilter сохраняет $or projectId/project_id (TODO-467)', () => {
    expect(projectFilter('p1')).toEqual({
      $or: [{ projectId: 'p1' }, { project_id: 'p1' }],
    });
  });
});
