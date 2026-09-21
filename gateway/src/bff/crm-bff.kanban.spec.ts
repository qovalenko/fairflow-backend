/**
 * [be-kanban-total] gateway BFF mapping for GetDealsKanban per-column
 * `total`/`has_more`. The domain returns snake_case `total` (proto int64 →
 * loader Long/number/string) + `has_more`; the BFF must surface them as numeric
 * `total` and boolean `hasMore` alongside the unchanged `deals` array — purely
 * additive (existing `stageId`/`stageName`/`deals` untouched).
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

describe('[be-kanban-total] CrmBffController.kanban total/hasMore mapping', () => {
  function build(kanbanResponse: unknown) {
    const pipeService = { getDealsKanban: jest.fn(() => of(kanbanResponse)) };
    const outboundMeta = { build: () => ({}) } as never;
    const ctrl = new CrmBffController(
      stubClient(pipeService),
      stubClient(),
      stubClient(),
      stubClient(),
      stubClient(),
      stubClient(),
      stubClient(),
      stubClient(),
      stubClient(),
      stubClient(),
      outboundMeta,
      {} as never, // docStorage
      { s3DocumentsBucket: 'fairflow-documents' } as never, // config (X4)
      { resolveNames: async () => new Map() } as never, // identity (TODO-207)
      {} as never, // reportRunNames (не используется в этом сценарии)
    );
    ctrl.onModuleInit();
    return ctrl;
  }

  const req = { user: { userId: 'u1' } } as never;

  it('maps total (number) + hasMore (bool) per column, keeps deals', async () => {
    const ctrl = build({
      pipeline: { id: 'pl-1', name: 'Default', is_default: true, stages: [] },
      columns: [
        { stage_id: 'st1', stage_name: 'New', deals: [{ id: 'd1' }], total: 60, has_more: true },
        { stage_id: 'st2', stage_name: 'Won', deals: [], total: 0, has_more: false },
      ],
    });

    const res = (await ctrl.kanban(req, 'proj-1')) as {
      columns: { stageId: string; total: number; hasMore: boolean; deals: unknown[] }[];
    };

    expect(res.columns[0]).toMatchObject({ stageId: 'st1', total: 60, hasMore: true });
    expect(res.columns[0].deals).toHaveLength(1);
    expect(res.columns[1]).toMatchObject({ stageId: 'st2', total: 0, hasMore: false });
  });

  it('coerces a Long-like/string total to a number and defaults are safe', async () => {
    const ctrl = build({
      pipeline: { id: 'pl-1', name: 'Default', stages: [] },
      // total absent → 0; string total (loader longs:String) → numeric
      columns: [
        { stage_id: 'st1', stage_name: 'New', deals: [] },
        { stage_id: 'st2', stage_name: 'Won', deals: [], total: '123', has_more: true },
      ],
    });

    const res = (await ctrl.kanban(req, 'proj-1')) as {
      columns: { total: number; hasMore: boolean }[];
    };

    expect(res.columns[0]).toMatchObject({ total: 0, hasMore: false });
    expect(res.columns[1]).toMatchObject({ total: 123, hasMore: true });
    expect(typeof res.columns[1].total).toBe('number');
  });
});
