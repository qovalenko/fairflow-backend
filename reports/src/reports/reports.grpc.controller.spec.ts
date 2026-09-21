import { Metadata } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { ReportsGrpcController } from './reports.grpc.controller';
import type { ReportsService } from './reports.service';
import type { MetricsService } from '../metrics/metrics.service';

const PID = 'proj-1';

function metadata(over: Partial<Record<string, string>> = {}): Metadata {
  const m = new Metadata();
  const defaults: Record<string, string> = {
    [GW_METADATA.PROJECT_ID]: PID,
    [GW_METADATA.USER_ID]: 'user-1',
    [GW_METADATA.REQUEST_ID]: 'req-1',
    [GW_METADATA.TRACE_ID]: 'trace-1',
    [GW_METADATA.GATEWAY_ISSUED_AT]: '2026-08-01T00:00:00.000Z',
    [GW_METADATA.ACTOR_TYPE]: 'user',
    [GW_METADATA.CALL_ID]: 'call-1',
    ...over,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (v !== undefined) m.set(k, v);
  }
  return m;
}

function stubReports() {
  return {
    list: jest.fn().mockResolvedValue({ list: [], total: 0 }),
    get: jest.fn().mockResolvedValue({ id: 'r1' }),
    create: jest.fn().mockResolvedValue({ id: 'r-new' }),
    update: jest.fn().mockResolvedValue({ id: 'r1' }),
    remove: jest.fn().mockResolvedValue({ ok: true }),
    run: jest.fn().mockResolvedValue({ data_json: '{}' }),
    export: jest.fn().mockResolvedValue({ url: 's3://x' }),
    getDashboard: jest.fn().mockResolvedValue({ kpis: {} }),
    getMetrics: jest.fn().mockResolvedValue({ slices: [] }),
    getDealStageHistory: jest.fn().mockResolvedValue({ list: [] }),
    drill: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
  };
}

describe('ReportsGrpcController — CRUD и изоляция projectId', () => {
  it('ListReports: trusted x-project-id, paging defaults, x-user-id', async () => {
    const reports = stubReports();
    const ctrl = new ReportsGrpcController(reports as unknown as ReportsService, {
      recordModuleRequest: jest.fn(),
    } as unknown as MetricsService);

    await ctrl.list({}, metadata());

    expect(reports.list).toHaveBeenCalledWith(PID, 0, 25, undefined, 'user-1');
  });

  it('CreateReport: snake_case поля и visibility доезжают в сервис', async () => {
    const reports = stubReports();
    const ctrl = new ReportsGrpcController(reports as unknown as ReportsService, {
      recordModuleRequest: jest.fn(),
    } as unknown as MetricsService);

    await ctrl.create(
      {
        name: 'N',
        description: 'D',
        kind: 'custom',
        spec_json: '{"a":1}',
        visibility: 'shared',
      },
      metadata(),
    );

    expect(reports.create).toHaveBeenCalledWith(
      PID,
      'N',
      'D',
      'custom',
      '{"a":1}',
      'user-1',
      'shared',
    );
  });

  it('GetReport / UpdateReport / DeleteReport прокидывают id и userId', async () => {
    const reports = stubReports();
    const ctrl = new ReportsGrpcController(reports as unknown as ReportsService, {
      recordModuleRequest: jest.fn(),
    } as unknown as MetricsService);

    await ctrl.get({ id: 'r1' }, metadata());
    await ctrl.update({ id: 'r1', name: 'Renamed', spec_json: '{}' }, metadata());
    await ctrl.remove({ id: 'r1' }, metadata());

    expect(reports.get).toHaveBeenCalledWith(PID, 'r1', 'user-1');
    expect(reports.update).toHaveBeenCalledWith(
      PID,
      'r1',
      'Renamed',
      undefined,
      '{}',
      undefined,
      'user-1',
    );
    expect(reports.remove).toHaveBeenCalledWith(PID, 'r1', 'user-1');
  });

  it('GetDealStageHistory: deal_id и dealId оба принимаются', async () => {
    const reports = stubReports();
    const ctrl = new ReportsGrpcController(reports as unknown as ReportsService, {
      recordModuleRequest: jest.fn(),
    } as unknown as MetricsService);

    await ctrl.getDealStageHistory({ dealId: 'd-9' }, metadata());

    expect(reports.getDealStageHistory).toHaveBeenCalledWith(
      PID,
      'd-9',
      undefined,
      { present: false },
    );
  });
});

describe('ReportsGrpcController — RunReport SLA-метрики', () => {
  it('recordModuleRequest ok после успешного run', async () => {
    const reports = stubReports();
    const metrics = { recordModuleRequest: jest.fn() };
    const ctrl = new ReportsGrpcController(
      reports as unknown as ReportsService,
      metrics as unknown as MetricsService,
    );

    await ctrl.run({ id: 'r1', params_json: '{}' }, metadata());

    expect(reports.run).toHaveBeenCalled();
    expect(metrics.recordModuleRequest).toHaveBeenCalledWith('RunReport', 'ok', expect.any(Number));
  });

  it('recordModuleRequest error и проброс исключения', async () => {
    const reports = stubReports();
    (reports.run as jest.Mock).mockRejectedValue(new Error('boom'));
    const metrics = { recordModuleRequest: jest.fn() };
    const ctrl = new ReportsGrpcController(
      reports as unknown as ReportsService,
      metrics as unknown as MetricsService,
    );

    await expect(ctrl.run({ id: 'r1' }, metadata())).rejects.toThrow('boom');
    expect(metrics.recordModuleRequest).toHaveBeenCalledWith(
      'RunReport',
      'error',
      expect.any(Number),
    );
  });
});

describe('ReportsGrpcController — statistics / export wiring', () => {
  it('GetDashboard прокидывает period/from/to и scope из metadata', async () => {
    const reports = stubReports();
    const ctrl = new ReportsGrpcController(reports as unknown as ReportsService, {
      recordModuleRequest: jest.fn(),
    } as unknown as MetricsService);

    await ctrl.getDashboard({ period: 'week', from: 1, to: 2 }, metadata());

    expect(reports.getDashboard).toHaveBeenCalledWith(
      PID,
      'week',
      1,
      2,
      undefined,
      undefined,
      { present: false },
    );
  });

  it('GetMetrics прокидывает period/slices и scope из metadata', async () => {
    const reports = stubReports();
    const ctrl = new ReportsGrpcController(reports as unknown as ReportsService, {
      recordModuleRequest: jest.fn(),
    } as unknown as MetricsService);

    await ctrl.getMetrics({ period: 'month', slices: ['stage'] }, metadata());

    expect(reports.getMetrics).toHaveBeenCalledWith(
      PID,
      'month',
      undefined,
      undefined,
      ['stage'],
      undefined,
      undefined,
      { present: false },
    );
  });

  it('ExportReport: format, params, call-id и enabled modules из metadata', async () => {
    const reports = stubReports();
    const ctrl = new ReportsGrpcController(reports as unknown as ReportsService, {
      recordModuleRequest: jest.fn(),
    } as unknown as MetricsService);
    const md = metadata({
      [GW_METADATA.CALL_ID]: 'gw-call-42',
      [GW_METADATA.ENABLED_MODULES]: JSON.stringify(['reports', 'deals']),
    });

    await ctrl.export({ id: 'r1', format: 'csv', params_json: '{}' }, md);

    expect(reports.export).toHaveBeenCalledWith(
      PID,
      'r1',
      'csv',
      '{}',
      undefined,
      'user-1',
      { present: false },
      'gw-call-42',
      ['reports', 'deals'],
    );
  });

  it('DrillReport: dimension/value/limit/cursor и scope', async () => {
    const reports = stubReports();
    const ctrl = new ReportsGrpcController(reports as unknown as ReportsService, {
      recordModuleRequest: jest.fn(),
    } as unknown as MetricsService);

    await ctrl.drill(
      {
        id: 'r1',
        params_json: '{}',
        dimension: 'stage_id',
        value: 's1',
        limit: 10,
        cursor: 'cur',
      },
      metadata(),
    );

    expect(reports.drill).toHaveBeenCalledWith(
      PID,
      'r1',
      '{}',
      'stage_id',
      's1',
      10,
      'cur',
      undefined,
      { present: false },
      'user-1',
    );
  });
});
