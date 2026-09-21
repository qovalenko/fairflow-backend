import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { V1DataBffController } from './v1-data-bff.controller';
import { serializeCompiledPredicate } from '@fairflow/shared';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function build(company: Record<string, unknown> = {}) {
  const outboundMeta = { build: () => ({}) } as never;
  const ctrl = new V1DataBffController(
    stubClient(),
    stubClient(),
    stubClient(company),
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

describe('mapCompanyForClient / FR-COMPANIES-380', () => {
  it('masks inn/kpp/bank* when ABAC gate fails', async () => {
    const ir = { op: 'and', args: [{ op: 'in', args: [{ ref: 'record.region' }, ['RU']] }] };
    const predicate = serializeCompiledPredicate({ ir: ir as never, mongo: null });
    const req = { headers: {}, user: { userId: 'u1' }, __accessPredicate: predicate } as never;
    const getCompany = jest.fn(() =>
      of({
        id: 'co1',
        name: 'Акме',
        inn: '7701234567',
        kpp: '770101001',
        bank_name: 'Сбер',
        bik: '044525225',
        region: 'EU',
      }),
    );
    const ctrl = build({ getCompany });
    const row = await ctrl.getCompany(req, 'co1', 'p1');
    expect(row.inn).toBe('***');
    expect(row.kpp).toBe('***');
    expect(row.bankName).toBe('***');
    expect(row.bik).toBe('***');
    expect(row.name).toBe('Акме');
  });

  it('reveals sensitive fields when no ABAC predicate is set', async () => {
    const req = { headers: {}, user: { userId: 'u1' } } as never;
    const getCompany = jest.fn(() =>
      of({
        id: 'co1',
        name: 'Акме',
        inn: '7701234567',
      }),
    );
    const ctrl = build({ getCompany });
    const row = await ctrl.getCompany(req, 'co1', 'p1');
    expect(row.inn).toBe('7701234567');
  });
});
