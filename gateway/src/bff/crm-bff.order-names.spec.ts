/**
 * TODO-207 — денормализованные имена продажи доходят до пользователя.
 *
 * Домен orders никогда не пишет productName/dealName/contactName/companyName
 * (createOrder кладёт только *Id, toOrder отдаёт `doc.productName ?? ''`), поэтому
 * список, канбан, карточка и CSV-экспорт продаж показывали пустые колонки.
 * Имена резолвит gateway теми же Get*-RPC соседних доменов (та же метадата ⇒ та же
 * видимость). Тесты фиксируют оба направления: с какими аргументами уходит запрос
 * в соседний домен и что в итоге уезжает в браузер.
 */
import { of, throwError } from 'rxjs';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { parseCompiledPredicate } from '@fairflow/shared';
import { CrmBffController } from './crm-bff.controller';

type Svc = Record<string, unknown>;

function stubClient(service: Svc = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

/** Записывает запрос (и метадату) , отданные gRPC-стабу, и отвечает `reply`. */
function spy(reply: unknown = {}) {
  const calls: Record<string, unknown>[] = [];
  const metas: unknown[] = [];
  const fn = (payload: Record<string, unknown>, md?: unknown) => {
    calls.push(payload);
    metas.push(md);
    return of(reply);
  };
  return Object.assign(fn, { calls, metas });
}

/** Стаб, отвечающий разным содержимым в зависимости от запрошенного id. */
function spyById(byId: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const metas: unknown[] = [];
  const fn = (payload: Record<string, unknown>, md?: unknown) => {
    calls.push(payload);
    metas.push(md);
    const hit = byId[String(payload.id)];
    if (hit === undefined) {
      return throwError(() => ({ code: GrpcStatus.NOT_FOUND, message: 'not found' }));
    }
    return of(hit);
  };
  return Object.assign(fn, { calls, metas });
}

/**
 * Стаб `IdentityResolverService` (батч id → ФИО). `calls` фиксирует, СКОЛЬКО раз
 * и с какими id ходили в auth: экспорт обязан резолвить одним батчем, как это
 * делает `AssigneeNameInterceptor` для остальных ответов.
 */
function identityStub(byId: Record<string, string> = {}, fail = false) {
  const calls: Array<Array<string | undefined | null>> = [];
  return {
    calls,
    resolveNames: async (_req: unknown, ids: Array<string | undefined | null>) => {
      calls.push(ids);
      if (fail) return new Map<string, string>();
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
  pipe?: Svc;
  orders?: Svc;
  product?: Svc;
  contact?: Svc;
  company?: Svc;
  identity?: ReturnType<typeof identityStub>;
  /** Стаб `GatewayOutboundMetadataService` — по умолчанию метадата не важна. */
  outboundMeta?: { build: (req: Record<string, unknown>) => unknown };
}) {
  const ctrl = new CrmBffController(
    stubClient(services.pipe ?? {}),
    stubClient(services.orders ?? {}),
    stubClient(services.product ?? {}),
    stubClient(), // activity
    stubClient(), // documents
    stubClient(), // reports
    stubClient(), // automation
    stubClient(), // control
    stubClient(services.contact ?? {}),
    stubClient(services.company ?? {}),
    (services.outboundMeta ?? { build: () => ({}) }) as never,
    {} as never,
    { s3DocumentsBucket: 'fairflow-documents' } as never, // config (X4)
    (services.identity ?? identityStub()) as never,
    {} as never, // reportRunNames
  );
  ctrl.onModuleInit();
  return ctrl;
}

/**
 * Запрос в том виде, в каком он доходит до хендлера продаж: оба гейта класса
 * (`GatewayModuleGuard`, `ProjectAccessGuard`) уже положили эффективный набор
 * модулей и снапшот политик проекта. `fillOrderNames` резолвит имена только по
 * тем донорам, чей subject разрешён этими двумя вердиктами (BX-ORD-NAMES-2).
 */
function gatedReq(over: Record<string, unknown> = {}) {
  return {
    user: { userId: 'u1' },
    headers: {},
    __enabledModules: ['orders', 'products', 'deals', 'contacts', 'companies'],
    __policySnapshot: '[]',
    ...over,
  } as never;
}

const req = gatedReq();

/** Строка продажи в том виде, в каком её отдаёт домен (snake_case, имена пустые). */
function domainOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    number: 'ORD-00001',
    type_id: 't1',
    type_name: 'Стандартная',
    product_id: 'p1',
    product_name: '',
    deal_id: 'd1',
    deal_name: '',
    contact_id: 'c1',
    contact_name: '',
    company_id: 'co1',
    company_name: '',
    stage_id: 's1',
    stage_name: 'Новая',
    assignee_id: 'u1',
    assignee_name: '',
    fields_json: '{}',
    status: 'ACTIVE',
    ...over,
  };
}

const directory = () => ({
  product: { getProduct: spyById({ p1: { id: 'p1', name: 'Тариф «Базовый»' } }) },
  pipe: { getDeal: spyById({ d1: { id: 'd1', name: 'Сделка №7' } }) },
  contact: {
    getContact: spyById({ c1: { id: 'c1', last_name: 'Иванов', first_name: 'Иван' } }),
  },
  company: { getCompany: spyById({ co1: { id: 'co1', name: 'ООО «Ромашка»' } }) },
});

describe('TODO-207 — GET /v1/orders отдаёт имена продукта/сделки/контакта/компании', () => {
  it('заполняет все четыре имени по id из записи', async () => {
    const dir = directory();
    const ctrl = build({
      orders: { listOrders: spy({ list: [domainOrder()], total: 1 }) },
      ...dir,
    });

    const res = (await ctrl.listOrders(req, 'proj-1')) as {
      list: Record<string, unknown>[];
      total: number;
    };

    expect(res.total).toBe(1);
    expect(res.list[0]).toMatchObject({
      productName: 'Тариф «Базовый»',
      dealName: 'Сделка №7',
      contactName: 'Иванов Иван',
      companyName: 'ООО «Ромашка»',
    });
  });

  it('спрашивает соседние домены в авторизованном проекте (query), а не в чём-то из тела', async () => {
    const dir = directory();
    const ctrl = build({
      orders: { listOrders: spy({ list: [domainOrder()], total: 1 }) },
      ...dir,
    });

    await ctrl.listOrders(req, 'proj-1');

    expect(dir.product.getProduct.calls[0]).toEqual({ project_id: 'proj-1', id: 'p1' });
    expect(dir.pipe.getDeal.calls[0]).toEqual({ project_id: 'proj-1', id: 'd1' });
    expect(dir.contact.getContact.calls[0]).toEqual({ project_id: 'proj-1', id: 'c1' });
    expect(dir.company.getCompany.calls[0]).toEqual({ project_id: 'proj-1', id: 'co1' });
  });

  it('берёт проект из x-project-id, когда query-параметра нет', async () => {
    const dir = directory();
    const ctrl = build({
      orders: { listOrders: spy({ list: [domainOrder()], total: 1 }) },
      ...dir,
    });

    await ctrl.listOrders(
      gatedReq({ headers: { 'x-project-id': 'proj-hdr' } }),
      undefined as never,
    );

    expect(dir.product.getProduct.calls[0]).toEqual({ project_id: 'proj-hdr', id: 'p1' });
  });

  it('делает один Get на уникальный id (дедуп внутри страницы)', async () => {
    const dir = directory();
    const ctrl = build({
      orders: {
        listOrders: spy({
          list: [domainOrder({ id: 'o1' }), domainOrder({ id: 'o2' })],
          total: 2,
        }),
      },
      ...dir,
    });

    const res = (await ctrl.listOrders(req, 'proj-1')) as { list: Record<string, unknown>[] };

    expect(dir.product.getProduct.calls).toHaveLength(1);
    expect(dir.pipe.getDeal.calls).toHaveLength(1);
    expect(res.list.map((o) => o.dealName)).toEqual(['Сделка №7', 'Сделка №7']);
  });

  it('не перетирает имя, которое домен уже денормализовал, и не ходит за ним', async () => {
    const dir = directory();
    const ctrl = build({
      orders: {
        listOrders: spy({
          list: [domainOrder({ product_name: 'Имя из документа' })],
          total: 1,
        }),
      },
      ...dir,
    });

    const res = (await ctrl.listOrders(req, 'proj-1')) as { list: Record<string, unknown>[] };

    expect(res.list[0].productName).toBe('Имя из документа');
    expect(dir.product.getProduct.calls).toHaveLength(0);
  });

  it('fail-soft: недоступная/удалённая запись оставляет имя пустым, список не падает', async () => {
    const dir = directory();
    const ctrl = build({
      orders: {
        // deal_id 'gone' нет в справочнике → стаб отвечает NOT_FOUND
        listOrders: spy({ list: [domainOrder({ deal_id: 'gone' })], total: 1 }),
      },
      ...dir,
    });

    const res = (await ctrl.listOrders(req, 'proj-1')) as { list: Record<string, unknown>[] };

    expect(res.list[0].dealName).toBe('');
    expect(res.list[0].productName).toBe('Тариф «Базовый»');
  });

  it('не ходит в домен за именем, когда id пустой', async () => {
    const dir = directory();
    const ctrl = build({
      orders: { listOrders: spy({ list: [domainOrder({ company_id: '' })], total: 1 }) },
      ...dir,
    });

    const res = (await ctrl.listOrders(req, 'proj-1')) as { list: Record<string, unknown>[] };

    expect(dir.company.getCompany.calls).toHaveLength(0);
    expect(res.list[0].companyName).toBe('');
  });
});

describe('TODO-207 — имена в карточке, канбане и выгрузке', () => {
  it('GET /v1/orders/:id — карточка получает имена', async () => {
    const dir = directory();
    const ctrl = build({ orders: { getOrder: spy(domainOrder()) }, ...dir });

    const order = (await ctrl.getOrder(req, 'o1', 'proj-1')) as Record<string, unknown>;

    expect(order).toMatchObject({
      productName: 'Тариф «Базовый»',
      dealName: 'Сделка №7',
      contactName: 'Иванов Иван',
      companyName: 'ООО «Ромашка»',
    });
  });

  it('GET /v1/orders/kanban — карточки колонок получают имена', async () => {
    const dir = directory();
    const ctrl = build({
      orders: {
        getOrdersKanban: spy({
          type_id: 't1',
          stages: [],
          columns: [{ stage_id: 's1', stage_name: 'Новая', orders: [domainOrder()] }],
        }),
      },
      ...dir,
    });

    const board = (await ctrl.ordersKanban(req, 'proj-1')) as {
      columns: { orders: Record<string, unknown>[] }[];
    };

    expect(board.columns[0].orders[0]).toMatchObject({
      productName: 'Тариф «Базовый»',
      dealName: 'Сделка №7',
      contactName: 'Иванов Иван',
    });
  });

  it('GET /v1/orders/export — колонки CSV больше не пустые', async () => {
    const dir = directory();
    const ctrl = build({ orders: { listOrders: spy({ list: [domainOrder()] }) }, ...dir });
    const res = { header: () => undefined } as never;

    const csv = (await ctrl.exportOrders(req, res, 'proj-1', 'csv')) as Buffer;
    const [head, row] = csv.toString('utf8').split('\n');

    expect(head.split(',')).toEqual([
      'number',
      'typeName',
      'productName',
      'dealName',
      'contactName',
      'companyName',
      'stageName',
      'assigneeName',
      'status',
      'createdAt',
    ]);
    expect(row).toContain('Тариф «Базовый»');
    expect(row).toContain('Сделка №7');
    expect(row).toContain('Иванов Иван');
    expect(row).toContain('ООО «Ромашка»');
  });

  it('PUT /v1/orders/:id — ответ на запись тоже с именами', async () => {
    const dir = directory();
    const ctrl = build({ orders: { updateOrder: spy(domainOrder()) }, ...dir });

    const order = (await ctrl.updateOrder(req, 'o1', 'proj-1', {
      customFields: { a: 1 },
    })) as Record<string, unknown>;

    expect(order.dealName).toBe('Сделка №7');
  });
});

/**
 * TODO-207 (хвост) — колонка «Ответственный» в выгрузке.
 *
 * Остальные ответы продаж имя ответственного получают от `AssigneeNameInterceptor`,
 * но он обходит ТЕЛО ответа, а `exportOrders` отдаёт готовый `Buffer` — интерцептору
 * там нечего обходить, и колонка уезжала пустой при заполненных остальных.
 */
describe('TODO-207 — assigneeName в выгрузке продаж', () => {
  const res = () => ({ header: () => undefined }) as never;
  const csvOf = (buf: Buffer) => buf.toString('utf8').split('\n');

  it('CSV: колонка assigneeName содержит ФИО, а не пусто', async () => {
    const identity = identityStub({ u1: 'Петров Пётр' });
    const ctrl = build({
      orders: { listOrders: spy({ list: [domainOrder()] }) },
      ...directory(),
      identity,
    });

    const [head, row] = csvOf((await ctrl.exportOrders(req, res(), 'proj-1', 'csv')) as Buffer);

    const cells = row.split(',');
    expect(cells[head.split(',').indexOf('assigneeName')]).toBe('Петров Пётр');
  });

  it('JSON: строка выгрузки несёт assigneeName', async () => {
    const identity = identityStub({ u1: 'Петров Пётр' });
    const ctrl = build({
      orders: { listOrders: spy({ list: [domainOrder()] }) },
      ...directory(),
      identity,
    });

    const buf = (await ctrl.exportOrders(req, res(), 'proj-1', 'json')) as Buffer;
    const rows = JSON.parse(buf.toString('utf8')) as Record<string, unknown>[];

    expect(rows[0].assigneeName).toBe('Петров Пётр');
    expect(rows[0].assigneeId).toBe('u1');
  });

  it('резолвит одним батчем на всю выгрузку (а не по строке)', async () => {
    const identity = identityStub({ u1: 'Петров Пётр', u2: 'Сидоров Сидор' });
    const ctrl = build({
      orders: {
        listOrders: spy({
          list: [
            domainOrder({ id: 'o1', assignee_id: 'u1' }),
            domainOrder({ id: 'o2', assignee_id: 'u2' }),
            domainOrder({ id: 'o3', assignee_id: 'u1' }),
          ],
        }),
      },
      ...directory(),
      identity,
    });

    const lines = csvOf((await ctrl.exportOrders(req, res(), 'proj-1', 'csv')) as Buffer);

    expect(identity.calls).toHaveLength(1);
    expect(identity.calls[0]).toEqual(['u1', 'u2', 'u1']);
    expect(lines.slice(1).map((l) => l.split(',')[7])).toEqual([
      'Петров Пётр',
      'Сидоров Сидор',
      'Петров Пётр',
    ]);
  });

  it('fail-soft: auth не ответил — ячейка пустая, выгрузка не падает', async () => {
    const ctrl = build({
      orders: { listOrders: spy({ list: [domainOrder()] }) },
      ...directory(),
      identity: identityStub({ u1: 'Петров Пётр' }, true),
    });

    const [, row] = csvOf((await ctrl.exportOrders(req, res(), 'proj-1', 'csv')) as Buffer);

    expect(row.split(',')[7]).toBe('');
    // Остальные имена на месте — деградирует только неразрешённая колонка.
    expect(row).toContain('Тариф «Базовый»');
  });

  it('неразрешённый id не подменяется фейком и не ломает соседние строки', async () => {
    const identity = identityStub({ u1: 'Петров Пётр' });
    const ctrl = build({
      orders: {
        listOrders: spy({
          list: [
            domainOrder({ id: 'o1', assignee_id: 'ghost' }),
            domainOrder({ id: 'o2', assignee_id: 'u1' }),
          ],
        }),
      },
      ...directory(),
      identity,
    });

    const lines = csvOf((await ctrl.exportOrders(req, res(), 'proj-1', 'csv')) as Buffer);

    expect(lines.slice(1).map((l) => l.split(',')[7])).toEqual(['', 'Петров Пётр']);
  });

  it('пустой assigneeId в auth не идёт (нечего резолвить)', async () => {
    const identity = identityStub({ u1: 'Петров Пётр' });
    const ctrl = build({
      orders: { listOrders: spy({ list: [domainOrder({ assignee_id: '' })] }) },
      ...directory(),
      identity,
    });

    const [, row] = csvOf((await ctrl.exportOrders(req, res(), 'proj-1', 'csv')) as Buffer);

    expect(identity.calls[0]).toEqual(['']);
    expect(row.split(',')[7]).toBe('');
  });
});

describe('BX-ORD-NAMES-2 — резолв имён уважает модульную изоляцию и политику проекта', () => {
  const orders = () => ({ orders: { listOrders: spy({ list: [domainOrder()], total: 1 }) } });

  it('выключенный в проекте модуль-донор не опрашивается, имя остаётся пустым', async () => {
    const dir = directory();
    const ctrl = build({ ...orders(), ...dir });

    // contacts/companies выключены в проекте — их домены собственного ModuleGuard
    // не имеют, поэтому единственный, кто может не пустить, это gateway.
    const res = (await ctrl.listOrders(
      gatedReq({ __enabledModules: ['orders', 'products', 'deals'] }),
      'proj-1',
    )) as { list: Record<string, unknown>[] };

    expect(dir.contact.getContact.calls).toHaveLength(0);
    expect(dir.company.getCompany.calls).toHaveLength(0);
    expect(res.list[0].contactName).toBe('');
    expect(res.list[0].companyName).toBe('');
    // Разрешённые доноры продолжают работать.
    expect(res.list[0].productName).toBe('Тариф «Базовый»');
    expect(res.list[0].dealName).toBe('Сделка №7');
  });

  it('project-wide deny `contacts:read` прячет ФИО контакта из списка продаж', async () => {
    const dir = directory();
    const ctrl = build({ ...orders(), ...dir });

    const res = (await ctrl.listOrders(
      gatedReq({
        __policySnapshot: JSON.stringify([{ effect: 'deny', subject: 'contacts', action: 'read' }]),
      }),
      'proj-1',
    )) as { list: Record<string, unknown>[] };

    expect(dir.contact.getContact.calls).toHaveLength(0);
    expect(res.list[0].contactName).toBe('');
    expect(res.list[0].dealName).toBe('Сделка №7');
  });

  it('deny на другое действие/другой subject резолв не трогает', async () => {
    const dir = directory();
    const ctrl = build({ ...orders(), ...dir });

    const res = (await ctrl.listOrders(
      gatedReq({
        __policySnapshot: JSON.stringify([
          { effect: 'deny', subject: 'contacts', action: 'delete' },
          { effect: 'allow', subject: 'deals', action: 'read' },
        ]),
      }),
      'proj-1',
    )) as { list: Record<string, unknown>[] };

    expect(res.list[0].contactName).toBe('Иванов Иван');
    expect(res.list[0].dealName).toBe('Сделка №7');
  });

  it('карточка и CSV подчиняются тому же вердикту, что и список', async () => {
    const dir = directory();
    const denied = gatedReq({
      __policySnapshot: JSON.stringify([{ effect: 'deny', subject: 'deals', action: 'read' }]),
    });

    const card = build({ orders: { getOrder: spy(domainOrder()) }, ...dir });
    const order = (await card.getOrder(denied, 'o1', 'proj-1')) as Record<string, unknown>;
    expect(order.dealName).toBe('');
    expect(order.productName).toBe('Тариф «Базовый»');

    const dir2 = directory();
    const exp = build({ orders: { listOrders: spy({ list: [domainOrder()] }) }, ...dir2 });
    const csv = (await exp.exportOrders(
      denied,
      { header: () => undefined } as never,
      'proj-1',
      'csv',
    )) as Buffer;
    expect(csv.toString('utf8')).not.toContain('Сделка №7');
    expect(dir2.pipe.getDeal.calls).toHaveLength(0);
  });

  it('fail-closed: без вердикта гейтов (нет __enabledModules) в доноры не ходим', async () => {
    const dir = directory();
    const ctrl = build({ ...orders(), ...dir });

    const res = (await ctrl.listOrders(
      { user: { userId: 'u1' }, headers: {} } as never,
      'proj-1',
    )) as { list: Record<string, unknown>[] };

    expect(dir.product.getProduct.calls).toHaveLength(0);
    expect(dir.pipe.getDeal.calls).toHaveLength(0);
    expect(dir.contact.getContact.calls).toHaveLength(0);
    expect(dir.company.getCompany.calls).toHaveLength(0);
    expect(res.list[0]).toMatchObject({ productName: '', dealName: '', contactName: '' });
  });

  it('fail-closed: битый снапшот политик резолв не разрешает', async () => {
    const dir = directory();
    const ctrl = build({ ...orders(), ...dir });

    const res = (await ctrl.listOrders(gatedReq({ __policySnapshot: 'not-json' }), 'proj-1')) as {
      list: Record<string, unknown>[];
    };

    expect(dir.product.getProduct.calls).toHaveLength(0);
    expect(res.list[0].productName).toBe('');
  });
});

/**
 * TODO-207 (хвост ревью) — выгрузка не должна молча обрываться на первой странице.
 *
 * Домен клампит размер страницы до 100 (`OrdersService.listOrders`), поэтому
 * прежний одиночный вызов с `page_size: 1000` отдавал ровно 100 строк, а меню во
 * фронте обещало «весь список». Стаб домена здесь ведёт себя как настоящий:
 * клампит page_size и режет выборку по page_index — обрезка ловится тестом.
 */
describe('TODO-207 — GET /v1/orders/export выгружает весь отфильтрованный набор', () => {
  /** Стаб FastifyReply, запоминающий выставленные заголовки. */
  const res = () => {
    const headers: Record<string, string> = {};
    return {
      headers,
      header: (k: string, v: string) => {
        headers[k] = v;
      },
    };
  };

  /** Стаб домена: клампит page_size до 100 и листает, как MongoDB skip/limit. */
  function pagedOrders(total: number) {
    const calls: Record<string, unknown>[] = [];
    const all = Array.from({ length: total }, (_, i) =>
      domainOrder({ id: `o${i + 1}`, number: `ORD-${String(i + 1).padStart(5, '0')}` }),
    );
    const fn = (payload: Record<string, unknown>) => {
      calls.push(payload);
      const size = Math.min(Math.max(Number(payload.page_size) || 25, 1), 100);
      const from = Number(payload.page_index ?? 0) * size;
      return of({ list: all.slice(from, from + size), total });
    };
    return Object.assign(fn, { calls });
  }

  const csvOf = (buf: Buffer) => buf.toString('utf8').split('\n');

  it('CSV: 250 продаж в домене → 250 строк данных в файле', async () => {
    const listOrders = pagedOrders(250);
    const ctrl = build({ orders: { listOrders }, ...directory() });
    const r = res();

    const lines = csvOf((await ctrl.exportOrders(req, r as never, 'proj-1', 'csv')) as Buffer);

    // header + 250 строк, без маркера усечения.
    expect(lines).toHaveLength(251);
    expect(lines[1]).toContain('ORD-00001');
    expect(lines[250]).toContain('ORD-00250');
    expect(lines.join('\n')).not.toContain('# Выгружены первые');
    expect(r.headers['X-Export-Truncated']).toBe('false');
    expect(r.headers['X-Export-Row-Count']).toBe('250');
    expect(r.headers['X-Export-Total']).toBe('250');
  });

  it('листает домен страницами по 100 (доменный максимум), а не одним page_size: 1000', async () => {
    const listOrders = pagedOrders(250);
    const ctrl = build({ orders: { listOrders }, ...directory() });

    await ctrl.exportOrders(req, res() as never, 'proj-1', 'csv');

    expect(listOrders.calls.map((c) => c.page_index)).toEqual([0, 1, 2]);
    expect(new Set(listOrders.calls.map((c) => c.page_size))).toEqual(new Set([100]));
  });

  it('фильтры и проект уходят в каждую страницу (выгрузка = тот же scope, что список)', async () => {
    const listOrders = pagedOrders(150);
    const ctrl = build({ orders: { listOrders }, ...directory() });

    await ctrl.exportOrders(
      req,
      res() as never,
      'proj-1',
      'csv',
      'акме',
      'd1',
      't1',
      'ACTIVE',
      's1',
    );

    expect(listOrders.calls).toHaveLength(2);
    for (const call of listOrders.calls) {
      expect(call).toMatchObject({
        project_id: 'proj-1',
        query: 'акме',
        deal_id: 'd1',
        type_id: 't1',
        status: 'ACTIVE',
        stage_id: 's1',
      });
    }
  });

  it('JSON: страницы склеиваются в один массив строк', async () => {
    const ctrl = build({ orders: { listOrders: pagedOrders(120) }, ...directory() });

    const buf = (await ctrl.exportOrders(req, res() as never, 'proj-1', 'json')) as Buffer;
    const rows = JSON.parse(buf.toString('utf8')) as Record<string, unknown>[];

    expect(rows).toHaveLength(120);
    expect(rows[119].number).toBe('ORD-00120');
  });

  it('ровно 100 продаж: одна страница, второй запрос не нужен, усечения нет', async () => {
    const listOrders = pagedOrders(100);
    const ctrl = build({ orders: { listOrders }, ...directory() });
    const r = res();

    const lines = csvOf((await ctrl.exportOrders(req, r as never, 'proj-1', 'csv')) as Buffer);

    expect(lines).toHaveLength(101);
    // Страница пришла полной → домен спрашивают ещё раз, и он отвечает пустой.
    expect(listOrders.calls.map((c) => c.page_index)).toEqual([0, 1]);
    expect(r.headers['X-Export-Truncated']).toBe('false');
  });

  it('дубль строки между страницами (параллельная запись) в файл не попадает дважды', async () => {
    const dup = () => domainOrder({ id: 'dup', number: 'ORD-DUP' });
    const pages = [
      {
        list: [...Array.from({ length: 99 }, (_, i) => domainOrder({ id: `a${i}` })), dup()],
        total: 101,
      },
      { list: [dup()], total: 101 },
    ];
    const listOrders = (payload: Record<string, unknown>) =>
      of(pages[Number(payload.page_index ?? 0)] ?? { list: [], total: 101 });
    const ctrl = build({ orders: { listOrders }, ...directory() });

    const lines = csvOf((await ctrl.exportOrders(req, res() as never, 'proj-1', 'csv')) as Buffer);

    expect(lines.filter((l) => l.includes('ORD-DUP'))).toHaveLength(1);
  });

  it('усечение по потолку объявляется явно: маркер в файле, имя файла и заголовки', async () => {
    // Домен «бесконечен»: всегда полная страница и total больше потолка.
    const total = 25000;
    const listOrders = (payload: Record<string, unknown>) =>
      of({
        list: Array.from({ length: 100 }, (_, i) =>
          domainOrder({ id: `o-${payload.page_index}-${i}` }),
        ),
        total,
      });
    const ctrl = build({ orders: { listOrders }, ...directory() });
    const r = res();

    const lines = csvOf((await ctrl.exportOrders(req, r as never, 'proj-1', 'csv')) as Buffer);

    // header + 10000 строк + маркер усечения последней строкой.
    expect(lines).toHaveLength(10002);
    expect(lines[10001]).toContain('Выгружены первые 10000 строк из 25000');
    expect(r.headers['X-Export-Truncated']).toBe('true');
    expect(r.headers['X-Export-Row-Count']).toBe('10000');
    expect(r.headers['X-Export-Total']).toBe('25000');
    expect(r.headers['Content-Disposition']).toContain('-first-10000-of-25000.csv');
  }, 30000);

  it('усечённый JSON несёт служебный маркер последним элементом', async () => {
    const total = 25000;
    const listOrders = (payload: Record<string, unknown>) =>
      of({
        list: Array.from({ length: 100 }, (_, i) =>
          domainOrder({ id: `o-${payload.page_index}-${i}` }),
        ),
        total,
      });
    const ctrl = build({ orders: { listOrders }, ...directory() });

    const buf = (await ctrl.exportOrders(req, res() as never, 'proj-1', 'json')) as Buffer;
    const rows = JSON.parse(buf.toString('utf8')) as Record<string, unknown>[];

    expect(rows).toHaveLength(10001);
    expect(rows[10000]).toMatchObject({ _truncated: true, _exported: 10000, _total: 25000 });
  }, 30000);

  /**
   * Обратная сторона того же дефекта: признак усечения считается по `total` домена,
   * а int64-поля у нас уже четырежды терялись по дороге (keepCase / longs: Number).
   * Потерянный total не должен превращать обрезок в «полную» выгрузку.
   */
  it('total домена потерян (0), а страницы не кончились → усечение всё равно объявлено', async () => {
    const listOrders = (payload: Record<string, unknown>) =>
      of({
        list: Array.from({ length: 100 }, (_, i) =>
          domainOrder({ id: `o-${payload.page_index}-${i}` }),
        ),
        total: 0,
      });
    const ctrl = build({ orders: { listOrders }, ...directory() });
    const r = res();

    const lines = csvOf((await ctrl.exportOrders(req, r as never, 'proj-1', 'csv')) as Buffer);

    expect(r.headers['X-Export-Truncated']).toBe('true');
    // Сколько осталось за бортом — неизвестно, поэтому «из N» не выдумываем.
    expect(lines[10001]).toContain('Выгружены первые 10000 строк по текущим фильтрам');
    expect(lines[10001]).not.toContain('из 10000');
    expect(r.headers['Content-Disposition']).toContain('-first-10000.csv');
  }, 30000);

  it('имена резолвятся для всех выгруженных строк, а не для первых 200', async () => {
    // 250 продаж с РАЗНЫМИ сделками — потолок резолва списка (200) обрезал бы хвост.
    const deals = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [
        `d${i + 1}`,
        { id: `d${i + 1}`, name: `Сделка ${i + 1}` },
      ]),
    );
    const dir = { ...directory(), pipe: { getDeal: spyById(deals) } };
    const all = Array.from({ length: 250 }, (_, i) =>
      domainOrder({ id: `o${i + 1}`, deal_id: `d${i + 1}` }),
    );
    const listOrders = (payload: Record<string, unknown>) => {
      const size = Math.min(Math.max(Number(payload.page_size) || 25, 1), 100);
      const from = Number(payload.page_index ?? 0) * size;
      return of({ list: all.slice(from, from + size), total: all.length });
    };
    const ctrl = build({ orders: { listOrders }, ...dir });

    const lines = csvOf((await ctrl.exportOrders(req, res() as never, 'proj-1', 'csv')) as Buffer);

    expect(lines[250]).toContain('Сделка 250');
  });
});

describe('BX-ORD-NAMES-3 — донор получает ABAC-предикат СВОЕГО subject, а не маршрутного', () => {
  const orders = () => ({ orders: { listOrders: spy({ list: [domainOrder()], total: 1 }) } });

  /** Стаб исходящей метадаты: отдаёт ровно то, что уедет в `x-access-predicate`. */
  const metaStub = () => ({
    build: (r: Record<string, unknown>) => ({ predicate: r.__accessPredicate }),
  });

  /** Предикат из метадаты, отданной стабу гRPC-клиента. */
  function predicateOf(md: unknown): string | undefined {
    return (md as { predicate?: string } | undefined)?.predicate;
  }

  /** Условный (сужающий) грант: читать можно только свои записи `subject`. */
  const ownRecordsOnly = (subject: string, ownerField: string) => ({
    effect: 'allow',
    subject,
    action: 'read',
    resource: '*',
    condition: { op: 'eq', left: { ref: `record.${ownerField}` }, right: { ref: 'user.id' } },
  });

  /**
   * Маршрут /v1/orders несёт предикат, скомпилированный под subject `orders`
   * (ProjectAccessGuard). Отдать его контактам — и дыра (условие про contacts не
   * применится), и баг (orders-условие по `assigneeId` не совпадёт с `ownerId`
   * контакта, имена опустеют у всех).
   */
  const withPolicy = (rules: unknown[]) =>
    gatedReq({
      __policySnapshot: JSON.stringify(rules),
      __accessPredicate: 'ORDERS-ROUTE-PREDICATE',
      __projectRole: 'member',
    });

  it('условный allow на contacts уезжает в contact предикатом contacts, а не orders', async () => {
    const dir = directory();
    const ctrl = build({ ...orders(), ...dir, outboundMeta: metaStub() });

    const res = (await ctrl.listOrders(
      withPolicy([ownRecordsOnly('orders', 'assigneeId'), ownRecordsOnly('contacts', 'ownerId')]),
      'proj-1',
    )) as { list: Record<string, unknown>[] };

    const sent = predicateOf(dir.contact.getContact.metas[0]);
    expect(sent).toBeDefined();
    expect(sent).not.toBe('ORDERS-ROUTE-PREDICATE');
    // Сузит выборку сам донор — предикатом в БД, а не фильтром в памяти gateway.
    expect(parseCompiledPredicate(sent).mongo).toEqual({ ownerId: { $eq: 'u1' } });
    expect(res.list[0].contactName).toBe('Иванов Иван');
  });

  it('донору без условных правил маршрутный orders-предикат не протекает', async () => {
    const dir = directory();
    const ctrl = build({ ...orders(), ...dir, outboundMeta: metaStub() });

    await ctrl.listOrders(
      withPolicy([ownRecordsOnly('orders', 'assigneeId'), ownRecordsOnly('contacts', 'ownerId')]),
      'proj-1',
    );

    // deals/products/companies условий не имеют: сужать нечем, но и приклеивать
    // чужое orders-условие (по нему в pipe совпадений не будет) нельзя.
    expect(predicateOf(dir.pipe.getDeal.metas[0])).toBeUndefined();
    expect(predicateOf(dir.product.getProduct.metas[0])).toBeUndefined();
    expect(predicateOf(dir.company.getCompany.metas[0])).toBeUndefined();
  });

  it('fail-closed: условное правило донора, неразрешимое на gateway, имя не резолвит', async () => {
    const dir = directory();
    const ctrl = build({ ...orders(), ...dir, outboundMeta: metaStub() });

    const res = (await ctrl.listOrders(
      withPolicy([
        {
          effect: 'allow',
          subject: 'contacts',
          action: 'read',
          resource: '*',
          // user.departmentId на gateway не резолвится → compileAccessPredicate
          // откладывает предикат целиком; идти в contacts без него нельзя.
          condition: {
            op: 'eq',
            left: { ref: 'record.departmentId' },
            right: { ref: 'user.departmentId' },
          },
        },
      ]),
      'proj-1',
    )) as { list: Record<string, unknown>[] };

    expect(dir.contact.getContact.calls).toHaveLength(0);
    expect(res.list[0].contactName).toBe('');
    // Доноры без условий продолжают работать.
    expect(res.list[0].dealName).toBe('Сделка №7');
  });

  it('fail-closed: условное правило донора при нерезолвнутом пользователе', async () => {
    const dir = directory();
    const ctrl = build({ ...orders(), ...dir, outboundMeta: metaStub() });

    const req0 = withPolicy([ownRecordsOnly('contacts', 'ownerId')]) as unknown as Record<
      string,
      unknown
    >;
    req0.user = {};

    const res = (await ctrl.listOrders(req0 as never, 'proj-1')) as {
      list: Record<string, unknown>[];
    };

    expect(dir.contact.getContact.calls).toHaveLength(0);
    expect(res.list[0].contactName).toBe('');
  });

  it('условный deny донора уезжает исключением ($nor), а не блокирует резолв', async () => {
    const dir = directory();
    const ctrl = build({ ...orders(), ...dir, outboundMeta: metaStub() });

    const res = (await ctrl.listOrders(
      withPolicy([
        {
          effect: 'deny',
          subject: 'companies',
          // action '*' — blanket-проверка (`action === 'read'`, как в
          // isDeniedByPolicy) сюда не попадает, работает предикат.
          action: '*',
          resource: '*',
          condition: { op: 'eq', left: { ref: 'record.secret' }, right: { lit: true } },
        },
      ]),
      'proj-1',
    )) as { list: Record<string, unknown>[] };

    const sent = predicateOf(dir.company.getCompany.metas[0]);
    expect(parseCompiledPredicate(sent).mongo).toEqual({
      $or: [{ $nor: [{ secret: { $eq: true } }] }, { ownerId: 'u1' }],
    });
    expect(res.list[0].companyName).toBe('ООО «Ромашка»');
  });
});
