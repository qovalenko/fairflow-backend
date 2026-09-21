/**
 * FR-PSET-050 — gateway BFF enable-impact preview (hard dependency cascade).
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

describe('FR-PSET-050 GET /projects/:pid/modules/:id/enable-impact', () => {
  it('lists hard dependencies that enabling the module would also turn on', async () => {
    const getProject = jest.fn(() =>
      of({
        effective_modules: ['deals'],
      }),
    );
    const ctrl = build({ getProject });

    const res = await ctrl.getModuleEnableImpact(req, 'p1', 'search');

    expect(getProject).toHaveBeenCalledWith({ id: 'p1' }, expect.anything());
    expect(res.cascadeModules).toEqual(
      expect.arrayContaining([
        { id: 'contacts', name: 'Контакты' },
        { id: 'companies', name: 'Клиенты' },
      ]),
    );
  });
});
