import { status } from '@grpc/grpc-js';
import { PipeGrpcController } from './pipe.grpc.controller';

describe('PipeGrpcController', () => {
  const pipeService = {
    listPipelines: jest.fn(),
    listDealSources: jest.fn(),
    listDeals: jest.fn(),
    countDealsByProduct: jest.fn(),
    getKanban: jest.fn(),
    getDeal: jest.fn(),
    moveDealToStage: jest.fn(),
    createDeal: jest.fn(),
    updateDeal: jest.fn(),
    deleteDeal: jest.fn(),
    createPipeline: jest.fn(),
    createDealSource: jest.fn(),
    provisionDefaults: jest.fn(),
  };

  const demoSeed = { seed: jest.fn() };

  // No Idempotency-Key in these tests → withIdempotency runs the executor directly.
  const idempotency = {
    withIdempotency: jest.fn((_p: string, _k: unknown, _op: string, exec: () => unknown) => exec()),
  };

  const controller = new PipeGrpcController(
    pipeService as never,
    demoSeed as never,
    idempotency as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps projectId to project_id for listPipelines', async () => {
    (pipeService.listPipelines as jest.Mock).mockResolvedValue({ list: [] });

    await controller.listPipelines({ projectId: 'p-1' });

    expect(pipeService.listPipelines).toHaveBeenCalledWith('p-1');
  });

  it('forwards listDealSources to the service', async () => {
    (pipeService.listDealSources as jest.Mock).mockResolvedValue({ list: [] });
    await controller.listDealSources({ project_id: 'p-4' });
    expect(pipeService.listDealSources).toHaveBeenCalledWith('p-4');
  });

  it('forwards countDealsByProduct with product_id', async () => {
    (pipeService.countDealsByProduct as jest.Mock).mockResolvedValue({ count: 3 });
    await controller.countDealsByProduct({ project_id: 'p-5', product_id: 'prod-1' });
    expect(pipeService.countDealsByProduct).toHaveBeenCalledWith('p-5', 'prod-1');
  });

  it('forwards kanban filters to the service', async () => {
    (pipeService.getKanban as jest.Mock).mockResolvedValue({ columns: [] });
    await controller.getKanban({
      project_id: 'p-6',
      pipeline_id: 'pl-1',
      assignee_id: 'u-1',
      query: 'Acme',
    });
    expect(pipeService.getKanban).toHaveBeenCalledWith(
      'p-6',
      'pl-1',
      undefined,
      { present: false },
      expect.objectContaining({ assigneeId: 'u-1' }),
      'Acme',
    );
  });

  it('forwards getDeal with visibility and ABAC predicate', async () => {
    (pipeService.getDeal as jest.Mock).mockResolvedValue({ id: 'd-1' });
    await controller.getDeal({ project_id: 'p-7', id: 'd-1' });
    expect(pipeService.getDeal).toHaveBeenCalledWith('p-7', 'd-1', undefined, false, {
      present: false,
    });
  });

  it('applies defaults for listDeals paging', async () => {
    (pipeService.listDeals as jest.Mock).mockResolvedValue({ list: [], total: 0 });

    await controller.listDeals({ project_id: 'p-2' });

    expect(pipeService.listDeals).toHaveBeenCalledWith(
      'p-2',
      0,
      25,
      undefined,
      undefined,
      undefined,
      undefined, // visibility scope (no metadata on the call)
      {
        assigneeId: undefined,
        departmentId: undefined,
        status: undefined,
        contactId: undefined,
        companyId: undefined,
        source: undefined,
        amountMin: undefined,
        amountMax: undefined,
        includeDeleted: false, // TODO-189: без флага — обычный список живых сделок
        minDaysOnStage: undefined,
        withoutAssignee: false,
      },
      { present: false }, // ABAC predicate absent → no narrowing
    );
  });

  it('forwards include_deleted to the service (TODO-189: корзина сделок)', async () => {
    (pipeService.listDeals as jest.Mock).mockResolvedValue({ list: [], total: 0 });

    await controller.listDeals({ project_id: 'p-2', include_deleted: true });

    // Флаг обязан доехать до сервиса: без этого «Корзина сделок» показывает живые.
    expect((pipeService.listDeals as jest.Mock).mock.calls[0][7]).toMatchObject({
      includeDeleted: true,
    });
  });

  it('forwards move deal payload', async () => {
    (pipeService.moveDealToStage as jest.Mock).mockResolvedValue({});

    await controller.moveDeal({ project_id: 'p-3', deal_id: 'd-1', stage_id: 'st-2' });

    expect(pipeService.moveDealToStage).toHaveBeenCalledWith(
      'p-3',
      'd-1',
      'st-2',
      undefined, // visibility scope
      '', // userId (no metadata)
      { present: false }, // ABAC predicate absent
    );
  });

  /**
   * TODO-075: no x-project-id metadata (s2s / internal caller) AND no body value
   * used to resolve to '' — the domain then wrote deals, pipelines and sources into
   * a pseudo-project nobody can read back and no purge removes. Every WRITE rpc now
   * fails fast with INVALID_ARGUMENT; reads keep the permissive resolution.
   */
  describe('TODO-075: empty projectId is rejected on write paths', () => {
    /** Asserts the call throws an RpcException carrying gRPC INVALID_ARGUMENT. */
    const expectInvalidArgument = (call: () => unknown) => {
      let thrown: unknown;
      try {
        call();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { error?: unknown }).error).toMatchObject({
        code: status.INVALID_ARGUMENT,
      });
    };

    it.each([
      ['createDeal', () => controller.createDeal({ name: 'Сделка' })],
      ['updateDeal', () => controller.updateDeal({ id: 'd-1', name: 'x' })],
      ['moveDeal', () => controller.moveDeal({ deal_id: 'd-1', stage_id: 'st-2' })],
      ['createPipeline', () => controller.createPipeline({ name: 'Воронка' })],
      ['createDealSource', () => controller.createDealSource({ name: 'Сайт' })],
      ['deleteDeal', () => controller.deleteDeal({ id: 'd-1' })],
      ['provisionDefaults', () => controller.provisionDefaults({})],
      ['seedDemoData', () => controller.seedDemoData({})],
    ])('%s rejects an unresolvable projectId', (_name, call) => {
      expectInvalidArgument(call);
      expect(pipeService.createDeal).not.toHaveBeenCalled();
      expect(pipeService.updateDeal).not.toHaveBeenCalled();
      expect(pipeService.createPipeline).not.toHaveBeenCalled();
      expect(pipeService.moveDealToStage).not.toHaveBeenCalled();
      expect(demoSeed.seed).not.toHaveBeenCalled();
    });

    it('also rejects a whitespace-only projectId', () => {
      expectInvalidArgument(() => controller.createDeal({ project_id: '   ', name: 'x' }));
    });

    it('still accepts a real projectId from the body (s2s path unchanged)', async () => {
      (pipeService.createPipeline as jest.Mock).mockResolvedValue({ id: 'pl-1' });
      await controller.createPipeline({ project_id: 'p-9', name: 'Воронка' });
      expect(pipeService.createPipeline).toHaveBeenCalledWith(
        'p-9',
        expect.objectContaining({ name: 'Воронка' }),
      );
    });

    it('reads also require projectId (shared resolveProjectId fail-closed)', () => {
      expectInvalidArgument(() => controller.listPipelines({}));
      expect(pipeService.listPipelines).not.toHaveBeenCalled();
    });
  });
});
