/**
 * FR-PSET-055 — gateway BFF maps control disable-impact to camelCase for the host.
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { V1DataBffController } from './v1-data-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function build(control: Record<string, unknown>) {
  const outboundMeta = { build: () => ({}) } as never;
  const ctrl = new V1DataBffController(
    stubClient(control),
    stubClient(),
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
    {} as never,
    {} as never,
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = { headers: {}, user: { userId: 'u1' } } as never;

describe('FR-PSET-055 GET /projects/:pid/modules/:id/disable-impact', () => {
  it('maps control response to camelCase for the settings UI', async () => {
    const getModuleDisableImpact = jest.fn(() =>
      of({
        dependent_enabled_modules: [{ id: 'orders', name: 'Продажи' }],
        unfinished_records: 5,
        stopped_automations: [{ id: 'r1', name: 'Правило' }],
        webhook_dlq_suspended: true,
      }),
    );
    const ctrl = build({ getModuleDisableImpact });

    const res = await ctrl.getModuleDisableImpact(req, 'p1', 'deals');

    expect(getModuleDisableImpact).toHaveBeenCalledWith(
      { project_id: 'p1', module_id: 'deals' },
      expect.anything(),
    );
    expect(res).toEqual({
      dependentEnabledModules: [{ id: 'orders', name: 'Продажи' }],
      unfinishedRecords: 5,
      stoppedAutomations: [{ id: 'r1', name: 'Правило' }],
      webhookDlqSuspended: true,
    });
  });
});
