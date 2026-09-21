/**
 * gRPC contract surface of the search domain.
 *
 * TODO-488: `IndexUpsert`/`IndexDelete` have no in-tree gRPC caller (the gateway
 * only uses Search/Reindex/Status), which made them look like dead contract. They
 * are deliberately kept as the operator/RECOVERY API (see search.proto) — so they
 * get an executable contract test here: field mapping in BOTH directions, and the
 * trusted-metadata rule for project_id.
 *
 * TODO-256: the new `truncated` / `skipped_types` of ReindexResponse must reach
 * the caller — a rebuild that silently lost rows is exactly the defect being fixed.
 */
import { SearchGrpcController } from './search.grpc.controller';
import type { SearchService } from './search.service';
import { GW_METADATA } from '@fairflow/shared';

const PID = 'proj-1';

/** Fake gRPC metadata carrying x-project-id. */
function metadata(projectId?: string) {
  return {
    get: (key: string) => (key === 'x-project-id' && projectId ? [projectId] : []),
  } as never;
}

function stubService() {
  return {
    search: jest.fn().mockResolvedValue({ list: [], total: 0, groups: [], total_by_type: {} }),
    reindex: jest.fn().mockResolvedValue({
      indexed_count: 3,
      sources: ['contacts'],
      truncated: true,
      skipped_types: ['contact'],
    }),
    status: jest.fn().mockResolvedValue({ dead_letter_count: 2 }),
    indexUpsert: jest.fn().mockResolvedValue({ ok: true }),
    indexDelete: jest.fn().mockResolvedValue({ ok: true }),
  };
}

describe('SearchGrpcController — Reindex response (TODO-256)', () => {
  it('passes truncated/skipped_types back to the caller unchanged', async () => {
    const svc = stubService();
    const ctrl = new SearchGrpcController(svc as unknown as SearchService);

    const res = await ctrl.reindex({ entity_types: ['contact'] }, metadata(PID));

    expect(svc.reindex).toHaveBeenCalledWith(PID, ['contact']);
    expect(res).toEqual({
      indexed_count: 3,
      sources: ['contacts'],
      truncated: true,
      skipped_types: ['contact'],
    });
  });
});

describe('SearchGrpcController — recovery API (TODO-488)', () => {
  it('IndexUpsert maps every snake_case field onto the service call', async () => {
    const svc = stubService();
    const ctrl = new SearchGrpcController(svc as unknown as SearchService);

    const ack = await ctrl.indexUpsert(
      {
        entity_type: 'deal',
        entity_id: 'd1',
        title: 'Big deal',
        subtitle: 'stage-1',
        path: '/p/proj-1/deals/d1',
        tokens: 'big deal',
        owner_id: 'user-1',
        department_id: 'dept-1',
        owner_field: 'ownerId',
        abac_attrs: { stageId: 'stage-1' },
        source_updated_at: 111,
        version: 222,
      },
      metadata(PID),
    );

    expect(ack).toEqual({ ok: true });
    expect(svc.indexUpsert).toHaveBeenCalledWith({
      projectId: PID,
      entityType: 'deal',
      entityId: 'd1',
      title: 'Big deal',
      subtitle: 'stage-1',
      path: '/p/proj-1/deals/d1',
      tokens: 'big deal',
      ownerId: 'user-1',
      departmentId: 'dept-1',
      ownerField: 'ownerId',
      abacAttrs: { stageId: 'stage-1' },
      sourceUpdatedAt: 111,
      version: 222,
    });
  });

  it('IndexDelete maps its fields and carries the version guard', async () => {
    const svc = stubService();
    const ctrl = new SearchGrpcController(svc as unknown as SearchService);

    const ack = await ctrl.indexDelete(
      { entity_type: 'deal', entity_id: 'd1', version: 900 },
      metadata(PID),
    );

    expect(ack).toEqual({ ok: true });
    expect(svc.indexDelete).toHaveBeenCalledWith({
      projectId: PID,
      entityType: 'deal',
      entityId: 'd1',
      version: 900,
    });
  });

  it('isolation: trusted x-project-id wins, a conflicting body project_id is rejected', async () => {
    const svc = stubService();
    const ctrl = new SearchGrpcController(svc as unknown as SearchService);

    expect(() =>
      ctrl.indexDelete(
        { project_id: 'other-project', entity_type: 'deal', entity_id: 'd1' },
        metadata(PID),
      ),
    ).toThrow();
    expect(svc.indexDelete).not.toHaveBeenCalled();
  });
});

describe('SearchGrpcController — query/status/list contracts', () => {
  function stubService() {
    return {
      search: jest.fn().mockResolvedValue({ list: [], total: 0, groups: [], total_by_type: {} }),
      reindex: jest.fn(),
      status: jest.fn().mockResolvedValue({ dead_letter_count: 4, backfilled_at: 1 }),
      indexUpsert: jest.fn(),
      indexDelete: jest.fn(),
      listUnassigned: jest.fn().mockResolvedValue({
        list: [{ entityType: 'deal', entityId: 'd1', title: 'No owner', updatedAt: 99 }],
        nextCursor: 'next-1',
        total: 1,
      }),
    };
  }

  it('Search maps snake_case and camelCase request fields onto the service call', async () => {
    const svc = stubService();
    const ctrl = new SearchGrpcController(svc as unknown as SearchService);

    await ctrl.query(
      {
        projectId: PID,
        query: ' acme ',
        page_index: 2,
        page_size: 10,
        entity_types: 'deal, contact' as unknown as string[],
        per_type_limit: 5,
        group_by: 'type',
        ownerScope: 'my',
        scopeDepartmentIds: 'dept-1, dept-2' as unknown as string[],
        minQueryChars: 2,
      },
      metadata(PID),
    );

    expect(svc.search).toHaveBeenCalledWith(PID, ' acme ', 2, 10, {
      entityTypes: ['deal', 'contact'],
      perTypeLimit: 5,
      groupBy: 'type',
      ownerScope: 'my',
      scopeDepartmentIds: ['dept-1', 'dept-2'],
      minQueryChars: 2,
      ctx: expect.any(Object),
    });
  });

  it('Search marks accessMalformed when the gateway predicate header is broken', async () => {
    const svc = stubService();
    const ctrl = new SearchGrpcController(svc as unknown as SearchService);
    const brokenPredicate = {
      get: (key: string) => {
        if (key === GW_METADATA.PROJECT_ID) return [PID];
        if (key === GW_METADATA.ACCESS_PREDICATE) return ['not-valid-base64-json'];
        return [];
      },
    } as never;

    await ctrl.query({ query: 'x' }, brokenPredicate);

    const opts = svc.search.mock.calls[0][4] as {
      ctx: { accessMalformed?: boolean; accessPredicate?: unknown };
    };
    expect(opts.ctx.accessMalformed).toBe(true);
    expect(opts.ctx.accessPredicate).toBeUndefined();
  });

  it('Status resolves project_id from trusted metadata', async () => {
    const svc = stubService();
    const ctrl = new SearchGrpcController(svc as unknown as SearchService);

    const res = await ctrl.status({}, metadata(PID));

    expect(svc.status).toHaveBeenCalledWith(PID);
    expect(res).toEqual({ dead_letter_count: 4, backfilled_at: 1 });
  });

  it('ListUnassigned maps camelCase rows back to snake_case for the wire contract', async () => {
    const svc = stubService();
    const ctrl = new SearchGrpcController(svc as unknown as SearchService);

    const res = await ctrl.listUnassigned(
      { resource: 'deal', limit: 25, cursor: 'cur-1' },
      metadata(PID),
    );

    expect(svc.listUnassigned).toHaveBeenCalledWith(PID, 'deal', 25, 'cur-1');
    expect(res).toEqual({
      list: [{ entity_type: 'deal', entity_id: 'd1', title: 'No owner', updated_at: 99 }],
      next_cursor: 'next-1',
      total: 1,
    });
  });
});
