/**
 * TODO-261 — постраничность страницы результатов, часть на gateway.
 *
 * Домен теперь режет группы честным срезом по `page_index`, а «есть ли
 * следующая страница» отдаёт полем `has_more`. BFF обязан (а) донести
 * `page_index` до домена и (б) НЕ потерять `has_more` в маппере — иначе
 * повторяется ровно тот класс дефекта, ради которого правка и делалась
 * («домен умеет, а до пользователя не доходит»): фронт снова остался бы с
 * догадкой `(page+1)*pageSize < total` и вечно активной кнопкой «Вперёд».
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CommonBffController, resetSearchSettingsCache } from './common-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function build(search: Record<string, unknown>) {
  const ctrl = new CommonBffController(
    stubClient(),
    stubClient(search),
    stubClient(),
    stubClient(),
    { build: () => ({}) } as never,
    { publishBadge: jest.fn(), subscribe: jest.fn() } as never,
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = () => ({ user: { userId: 'u1' }, headers: { 'x-project-id': 'p1' } }) as never;

beforeEach(() => resetSearchSettingsCache());

describe('[TODO-261] search pagination pass-through', () => {
  it('forwards the requested page to the domain', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = build({ search: rpc });

    await ctrl.search(req(), 'иван', 'p1', '2', '25');

    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ page_index: 2, page_size: 25 }), {});
  });

  it('maps has_more from the domain answer', async () => {
    const rpc = jest.fn(() =>
      of({
        groups: [{ entity_type: 'contact', type_total: 40, list: [{ id: 'a', updated_at: 5 }] }],
        total: 40,
        total_by_type: { contact: 40 },
        has_more: true,
      }),
    );
    const ctrl = build({ search: rpc });

    const res = await ctrl.search(req(), 'иван', 'p1', '0', '25');

    expect(res.has_more).toBe(true);
  });

  it('a domain answer without has_more degrades to "нет следующей", not to a phantom page', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 100, total_by_type: { contact: 100 } }));
    const ctrl = build({ search: rpc });

    const res = await ctrl.search(req(), 'иван', 'p1', '0', '25');

    // `total` большой, но раз домен не сказал «есть ещё» — кнопка «Вперёд»
    // должна быть выключена, а не включена по арифметике на клиенте.
    expect(res.has_more).toBe(false);
  });
});
