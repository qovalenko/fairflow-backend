/**
 * TODO-248 (FR-MREP-8) — `preset_key` must survive the last hop.
 *
 * The domain stores `presetKey` per builtin report and `Report.preset_key = 8`
 * carries it over gRPC, but the BFF projection `reportFe()` used to drop it.
 * The FE (`modules/reports/src/Reports.tsx`) matches a tab to its report
 * definition by `presetKey` and only falls back to a positional heuristic when
 * it is absent — and that heuristic is wrong here, because `list()` sorts by
 * `updatedAt desc, _id desc` while all six seeded presets share one timestamp,
 * so the list arrives in REVERSE seed order.
 *
 * Hence: assert the key reaches the browser on every endpoint that projects a
 * report, and that a custom report (empty string on the wire) becomes `null`.
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';

type Svc = Record<string, unknown>;

function stubClient(service: Svc = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function build(reports: Svc) {
  const ctrl = new CrmBffController(
    stubClient(), // pipe
    stubClient(), // orders
    stubClient(), // product
    stubClient(), // activity
    stubClient(), // documents
    stubClient(reports),
    stubClient(), // automation
    stubClient(), // control
    stubClient(), // contact
    stubClient(), // company
    { build: () => ({}) } as never,
    {} as never, // docStorage
    { s3DocumentsBucket: 'fairflow-documents' } as never, // config (X4)
    { resolveNames: async () => new Map() } as never, // identity (TODO-207)
    {} as never, // reportRunNames (не используется в этом сценарии)
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = { user: { userId: 'u1' }, headers: {} } as never;

/** A builtin report as the domain emits it (keepCase: true loader). */
function wireReport(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    project_id: 'p1',
    name: 'По продажам',
    description: '',
    kind: 'sales',
    preset_key: 'sales',
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe('TODO-248 — reportFe() carries preset_key to the FE', () => {
  it('GET /v1/reports returns presetKey for every builtin in the list', async () => {
    // Reverse seed order on purpose: this is exactly what makes the FE index
    // heuristic pick the wrong definition when presetKey is missing.
    const listReports = () =>
      of({
        list: [
          wireReport({ id: 'r6', kind: 'by_managers', preset_key: 'by_managers' }),
          wireReport({ id: 'r5', kind: 'sources', preset_key: 'sources' }),
          wireReport({ id: 'r1', kind: 'sales', preset_key: 'sales' }),
        ],
        total: 3,
      });
    const ctrl = build({ listReports });

    const res = (await ctrl.listReports(req, 'p1')) as {
      list: { id: string; presetKey: string | null }[];
    };

    expect(res.list.map((r) => [r.id, r.presetKey])).toEqual([
      ['r6', 'by_managers'],
      ['r5', 'sources'],
      ['r1', 'sales'],
    ]);
  });

  it('GET /v1/reports/:id returns presetKey', async () => {
    const ctrl = build({ getReport: () => of(wireReport({ preset_key: 'funnel' })) });

    const res = (await ctrl.getReport(req, 'r1', 'p1')) as { presetKey: string | null };

    expect(res.presetKey).toBe('funnel');
  });

  it('normalises the proto empty string of a custom report to null', async () => {
    const ctrl = build({
      getReport: () => of(wireReport({ kind: 'custom', preset_key: '' })),
    });

    const res = (await ctrl.getReport(req, 'r9', 'p1')) as { presetKey: string | null };

    expect(res.presetKey).toBeNull();
  });

  it('createReport/updateReport project presetKey too', async () => {
    const ctrl = build({
      createReport: () => of(wireReport({ kind: 'custom', preset_key: '' })),
      updateReport: () => of(wireReport({ preset_key: 'clients' })),
    });

    const created = (await ctrl.createReport(req, { name: 'X' }, 'p1')) as {
      presetKey: string | null;
    };
    const updated = (await ctrl.updateReport(req, 'r1', 'p1', { name: 'Y' })) as {
      presetKey: string | null;
    };

    expect(created.presetKey).toBeNull();
    expect(updated.presetKey).toBe('clients');
  });
});
