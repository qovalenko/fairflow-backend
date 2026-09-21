/**
 * TODO-414 — карточка «История» продажи получает РЕАЛЬНУЮ ленту изменений.
 *
 * Раньше фронт синтезировал два события из createdAt/updatedAt (автор — из
 * ответственного, diff — выдуманный), потому что ручки не было. События же
 * лежали в неизменяемой цепочке audit с самого начала: orders эмитит
 * `crm.order.*` с subject `order/<id>`, audit биндится на `crm.#` и кладёт
 * `entityType='order'`. Тесты фиксируют оба конца: с чем gateway идёт в audit и
 * что уезжает в браузер (включая перевод сырых id этапов/пользователей в имена).
 */
import { of, throwError } from 'rxjs';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';

type Svc = Record<string, unknown>;

function stubClient(service: Svc = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function spy(reply: unknown = {}) {
  const calls: Record<string, unknown>[] = [];
  const fn = (payload: Record<string, unknown>) => {
    calls.push(payload);
    return of(reply);
  };
  return Object.assign(fn, { calls });
}

function identityStub(byId: Record<string, string> = {}) {
  const calls: Array<Array<string | undefined | null>> = [];
  return {
    calls,
    resolveNames: async (_req: unknown, ids: Array<string | undefined | null>) => {
      calls.push(ids);
      const m = new Map<string, string>();
      for (const id of ids) {
        const name = id ? byId[String(id)] : undefined;
        if (name) m.set(String(id), name);
      }
      return m;
    },
  };
}

function build(services: {
  orders?: Svc;
  audit?: Svc;
  identity?: ReturnType<typeof identityStub>;
}) {
  const ctrl = new CrmBffController(
    stubClient(), // pipe
    stubClient(services.orders ?? {}),
    stubClient(), // product
    stubClient(), // activity
    stubClient(), // documents
    stubClient(), // reports
    stubClient(), // automation
    stubClient(), // control
    stubClient(), // contact
    stubClient(), // company
    { build: () => ({ md: true }) } as never,
    {} as never, // docStorage
    { s3DocumentsBucket: 'fairflow-documents' } as never, // config (X4)
    (services.identity ?? identityStub()) as never,
    {} as never, // reportRunNames
    stubClient(services.audit ?? {}),
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = { user: { userId: 'u1' }, headers: {} } as never;

/** Продажа в том виде, в каком её отдаёт домен (snake_case). */
const domainOrder = {
  id: 'o1',
  number: 'ORD-00001',
  type_id: 't1',
  order_type_version: 3,
  stage_id: 's2',
  fields_json: '{}',
  status: 'ACTIVE',
};

/** Ревизия типа, к которой продажа закреплена: имена этапов и подписи полей. */
const typeDetail = {
  id: 't1',
  name: 'Стандартная',
  revision: {
    version: 3,
    stages: [
      { id: 's1', name: 'Новая' },
      { id: 's2', name: 'Оформление' },
    ],
    fields: [{ key: 'inn', label: 'ИНН' }],
  },
};

function auditEvent(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    event_name: 'crm.order.created',
    entity_type: 'order',
    entity_id: 'o1',
    actor_id: 'u7',
    actor_type: 'user',
    payload_json: '{"orderId":"o1"}',
    created_at: 1_700_000_000_000,
    ...over,
  };
}

describe('GET orders/:id/history — реальная лента из цепочки audit', () => {
  it('спрашивает у audit ровно события этой продажи и отдаёт их фронту', async () => {
    const listEvents = spy({ list: [auditEvent()], total: 1 });
    const ctrl = build({
      orders: { getOrder: spy(domainOrder), getOrderType: spy(typeDetail) },
      audit: { listEvents },
      identity: identityStub({ u7: 'Петров П.' }),
    });

    const res = (await ctrl.orderHistory(req, 'o1', 'p1')) as {
      items: Record<string, unknown>[];
      hasMore: boolean;
    };

    expect(listEvents.calls[0]).toMatchObject({
      project_id: 'p1',
      entity_type: 'order',
      entity_id: 'o1',
      page_index: 0,
    });
    expect(res.hasMore).toBe(false);
    expect(res.items).toEqual([
      {
        id: 'e1',
        type: 'crm.order.created',
        userId: 'u7',
        userName: 'Петров П.',
        // grpcBffCall переводит известные timestamp-поля мс→сек на выходе BFF
        // (TS_KEYS), фронтовый toOrderDayjs принимает обе шкалы — история
        // остаётся в том же контракте дат, что и остальные ответы BFF.
        timestamp: 1_700_000_000,
        summary: 'Продажа создана',
        changedFields: [],
      },
    ]);
  });

  it('гейт видимости: сначала GetOrder, и при отказе в audit не ходим', async () => {
    const listEvents = spy({ list: [auditEvent()], total: 1 });
    const getOrder = (payload: Record<string, unknown>) => {
      expect(payload).toMatchObject({ project_id: 'p1', id: 'o1' });
      return throwError(() => ({ code: GrpcStatus.NOT_FOUND, message: 'not found' }));
    };
    const ctrl = build({
      orders: { getOrder, getOrderType: spy(typeDetail) },
      audit: { listEvents },
    });

    await expect(ctrl.orderHistory(req, 'o1', 'p1')).rejects.toBeDefined();
    expect(listEvents.calls).toHaveLength(0);
  });

  it('этапы подписываются именами ЗАКРЕПЛЁННОЙ ревизии типа', async () => {
    const getOrderType = spy(typeDetail);
    const ctrl = build({
      orders: { getOrder: spy(domainOrder), getOrderType },
      audit: {
        listEvents: spy({
          list: [
            auditEvent({
              id: 'e2',
              event_name: 'crm.order.stage_changed',
              payload_json: '{"orderId":"o1","fromStageId":"s1","toStageId":"s2"}',
            }),
          ],
          total: 1,
        }),
      },
    });

    const res = (await ctrl.orderHistory(req, 'o1', 'p1')) as { items: Record<string, unknown>[] };

    // версия берётся из самой продажи, а не «последняя» — иначе история старой
    // продажи подписывалась бы этапами свежей ревизии
    expect(getOrderType.calls[0]).toMatchObject({ project_id: 'p1', id: 't1', version: 3 });
    expect(res.items[0]).toMatchObject({
      summary: 'Смена этапа',
      changedFields: [{ field: 'Этап', old: 'Новая', new: 'Оформление' }],
    });
  });

  it('статус переводится в подпись, а служебное событие подписано «Система»', async () => {
    const ctrl = build({
      orders: { getOrder: spy(domainOrder), getOrderType: spy(typeDetail) },
      audit: {
        listEvents: spy({
          list: [
            auditEvent({
              id: 'e3',
              event_name: 'crm.order.status_changed',
              actor_id: '',
              actor_type: 'service',
              payload_json: '{"orderId":"o1","from":"SENDING","to":"DONE"}',
            }),
          ],
          total: 1,
        }),
      },
    });

    const res = (await ctrl.orderHistory(req, 'o1', 'p1')) as { items: Record<string, unknown>[] };

    expect(res.items[0]).toMatchObject({
      summary: 'Смена статуса',
      userName: 'Система',
      changedFields: [{ field: 'Статус', old: 'Отправка', new: 'Оформлена' }],
    });
  });

  it('в crm.order.updated показывает ТОЛЬКО реально изменившиеся поля и имена людей', async () => {
    const identity = identityStub({ u7: 'Петров П.', u8: 'Сидоров С.', u9: 'Иванов И.' });
    const ctrl = build({
      orders: { getOrder: spy(domainOrder), getOrderType: spy(typeDetail) },
      audit: {
        listEvents: spy({
          list: [
            auditEvent({
              id: 'e4',
              event_name: 'crm.order.updated',
              payload_json: JSON.stringify({
                orderId: 'o1',
                before: { assigneeId: 'u8', customFields: { inn: '7701', note: 'одинаково' } },
                after: { assigneeId: 'u9', customFields: { inn: '7702', note: 'одинаково' } },
              }),
            }),
          ],
          total: 1,
        }),
      },
      identity,
    });

    const res = (await ctrl.orderHistory(req, 'o1', 'p1')) as { items: Record<string, unknown>[] };

    expect(res.items[0]).toMatchObject({
      summary: 'Изменены данные продажи',
      userName: 'Петров П.',
      changedFields: [
        { field: 'Ответственный', old: 'Сидоров С.', new: 'Иванов И.' },
        { field: 'ИНН', old: '7701', new: '7702' },
      ],
    });
    // имена резолвятся ОДНИМ батчем на запрос: автор + оба ответственных
    expect(identity.calls).toHaveLength(1);
    expect([...identity.calls[0]].sort()).toEqual(['u7', 'u8', 'u9']);
  });

  it('недоступный тип продажи не роняет историю (fail-soft, id этапов как есть)', async () => {
    const ctrl = build({
      orders: {
        getOrder: spy(domainOrder),
        getOrderType: () => throwError(() => ({ code: GrpcStatus.NOT_FOUND, message: 'gone' })),
      },
      audit: {
        listEvents: spy({
          list: [
            auditEvent({
              event_name: 'crm.order.stage_changed',
              payload_json: '{"fromStageId":"s1","toStageId":"s2"}',
            }),
          ],
          total: 9,
        }),
      },
    });

    const res = (await ctrl.orderHistory(req, 'o1', 'p1')) as {
      items: Record<string, unknown>[];
      hasMore: boolean;
    };

    expect(res.items[0]).toMatchObject({
      changedFields: [{ field: 'Этап', old: 's1', new: 's2' }],
    });
    // total из audit больше отданной страницы → фронту честно говорим, что есть ещё
    expect(res.hasMore).toBe(true);
  });
});
