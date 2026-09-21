/**
 * Бюджет и ограничение частоты выгрузки продаж (`GET /v1/orders/export`).
 *
 * Ревью волны: выгрузка была единственным маршрутом, где ОДИН HTTP-запрос
 * разворачивался в тысячи gRPC-вызовов (до 100 `ListOrders` + до 4 одиночных
 * Get* на строку в четыре соседних домена), причём собственный дедлайн был
 * только у каждого вызова по отдельности — общего потолка ни по времени, ни по
 * количеству, ни по числу ОДНОВРЕМЕННЫХ выгрузок не существовало. Тесты
 * фиксируют три ограничителя и — обязательное условие — что деградация
 * объявлена пользователю, а не молчалива.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { Observable, Subject, of, throwError } from 'rxjs';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';
import { ExportBudget, ExportInflightLimiter, ordersExportLimits } from './orders-export-budget';

type Svc = Record<string, unknown>;

function stubClient(service: Svc = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

/** Стаб донора имён: считает вызовы и отвечает по id. */
function donorSpy(name: (id: string) => Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const fn = (payload: Record<string, unknown>) => {
    calls.push(payload);
    return of(name(String(payload.id)));
  };
  return Object.assign(fn, { calls });
}

function identityStub() {
  return {
    resolveNames: async () => new Map<string, string>(),
  };
}

function build(services: {
  orders?: Svc;
  product?: Svc;
  pipe?: Svc;
  contact?: Svc;
  company?: Svc;
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
    { build: () => ({}) } as never,
    {} as never,
    { s3DocumentsBucket: 'fairflow-documents' } as never, // config (X4)
    identityStub() as never,
    {} as never, // reportRunNames
  );
  ctrl.onModuleInit();
  return ctrl;
}

function gatedReq(over: Record<string, unknown> = {}) {
  return {
    user: { userId: 'u1' },
    headers: {},
    __enabledModules: ['orders', 'products', 'deals', 'contacts', 'companies'],
    __policySnapshot: '[]',
    ...over,
  } as never;
}

/** Стаб FastifyReply, запоминающий выставленные заголовки. */
function res() {
  const headers: Record<string, string> = {};
  return {
    headers,
    header: (k: string, v: string) => {
      headers[k] = v;
    },
  };
}

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

/** Четыре донора имён, каждый со своим счётчиком вызовов. */
function directory() {
  const product = donorSpy((id) => ({ id, name: `Продукт ${id}` }));
  const pipe = donorSpy((id) => ({ id, name: `Сделка ${id}` }));
  const contact = donorSpy((id) => ({ id, last_name: 'Иванов', first_name: id }));
  const company = donorSpy((id) => ({ id, name: `ООО ${id}` }));
  return {
    services: {
      product: { getProduct: product },
      pipe: { getDeal: pipe },
      contact: { getContact: contact },
      company: { getCompany: company },
    },
    donorCalls: () =>
      product.calls.length + pipe.calls.length + contact.calls.length + company.calls.length,
  };
}

const ENV_KEYS = [
  'ORDERS_EXPORT_BUDGET_MS',
  'ORDERS_EXPORT_NAME_RPC_BUDGET',
  'ORDERS_EXPORT_MAX_INFLIGHT_PER_USER',
  'ORDERS_EXPORT_MAX_INFLIGHT_PER_PROJECT',
  'ORDERS_EXPORT_MAX_INFLIGHT',
] as const;

describe('ExportBudget — общий бюджет одного запроса выгрузки', () => {
  it('потолок Get*-вызовов общий на все виды имён и выдаётся порциями', () => {
    const b = new ExportBudget({ budgetMs: 60_000, nameRpcBudget: 10 });

    expect(b.takeCalls(8)).toBe(8);
    // Остаток меньше запрошенного — выдаётся ровно остаток, и это уже деградация.
    expect(b.takeCalls(8)).toBe(2);
    expect(b.namesIncomplete).toBe(true);
    expect(b.takeCalls(8)).toBe(0);
    expect(b.callsRemaining).toBe(0);
  });

  it('полностью уложившийся резолв ничего не помечает', () => {
    const b = new ExportBudget({ budgetMs: 60_000, nameRpcBudget: 10 });

    expect(b.takeCalls(4)).toBe(4);
    expect(b.namesIncomplete).toBe(false);
    expect(b.timedOut).toBe(false);
  });

  it('время считается по внешним часам, дедлайн — момент старта плюс бюджет', () => {
    let now = 1_000;
    const b = new ExportBudget({ budgetMs: 100, nameRpcBudget: 1, now: () => now });

    expect(b.hasTime()).toBe(true);
    now = 1_099;
    expect(b.hasTime()).toBe(true);
    now = 1_100;
    expect(b.hasTime()).toBe(false);
  });

  it('нулевой/отрицательный бюджет вызовов не уходит в минус', () => {
    const b = new ExportBudget({ budgetMs: 60_000, nameRpcBudget: -5 });

    expect(b.takeCalls(3)).toBe(0);
    expect(b.callsRemaining).toBe(0);
  });
});

describe('ExportInflightLimiter — сколько выгрузок разрешено одновременно', () => {
  const limits = { budgetMs: 1, nameRpcBudget: 1, perUser: 1, perProject: 2, total: 3 };

  it('второй одновременный запрос того же пользователя слот не получает', () => {
    const l = new ExportInflightLimiter();

    expect(l.acquire('u1', 'p1', limits)).toBeTruthy();
    expect(l.acquire('u1', 'p1', limits)).toBeNull();
  });

  it('другой пользователь того же проекта проходит, третий упирается в лимит проекта', () => {
    const l = new ExportInflightLimiter();

    expect(l.acquire('u1', 'p1', limits)).toBeTruthy();
    expect(l.acquire('u2', 'p1', limits)).toBeTruthy();
    expect(l.acquire('u3', 'p1', limits)).toBeNull();
  });

  it('процессный потолок ограничивает и разные проекты', () => {
    const l = new ExportInflightLimiter();

    expect(l.acquire('u1', 'p1', limits)).toBeTruthy();
    expect(l.acquire('u2', 'p2', limits)).toBeTruthy();
    expect(l.acquire('u3', 'p3', limits)).toBeTruthy();
    expect(l.acquire('u4', 'p4', limits)).toBeNull();
  });

  it('release возвращает слот и идемпотентен (двойной вызов слоты не печатает)', () => {
    const l = new ExportInflightLimiter();
    const release = l.acquire('u1', 'p1', limits);

    release?.();
    release?.();

    expect(l.inflight).toBe(0);
    expect(l.acquire('u1', 'p1', limits)).toBeTruthy();
    expect(l.inflight).toBe(1);
  });
});

describe('ordersExportLimits — значения по умолчанию и переопределение из env', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('по умолчанию бюджет конечен, а параллельных выгрузок на пользователя — одна', () => {
    expect(ordersExportLimits()).toEqual({
      budgetMs: 45_000,
      nameRpcBudget: 2000,
      perUser: 1,
      perProject: 2,
      total: 4,
    });
  });

  it('env переопределяет, мусор игнорируется (лимит не снимается опечаткой)', () => {
    process.env.ORDERS_EXPORT_BUDGET_MS = '5000';
    process.env.ORDERS_EXPORT_MAX_INFLIGHT_PER_USER = 'нет';
    process.env.ORDERS_EXPORT_MAX_INFLIGHT = '0';

    const l = ordersExportLimits();

    expect(l.budgetMs).toBe(5000);
    expect(l.perUser).toBe(1);
    // 0 ниже допустимого минимума (1) — иначе выгрузка была бы выключена целиком.
    expect(l.total).toBe(4);
  });
});

describe('GET /v1/orders/export — усиление нагрузки ограничено бюджетом запроса', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** Домен с `total` продаж, все со СВОИМИ id доноров (худший случай резолва). */
  function pagedOrders(total: number, delayMs = 0) {
    const all = Array.from({ length: total }, (_, i) =>
      domainOrder({
        id: `o${i + 1}`,
        number: `ORD-${String(i + 1).padStart(5, '0')}`,
        product_id: `p${i + 1}`,
        deal_id: `d${i + 1}`,
        contact_id: `c${i + 1}`,
        company_id: `co${i + 1}`,
      }),
    );
    const calls: Record<string, unknown>[] = [];
    const fn = (payload: Record<string, unknown>) => {
      calls.push(payload);
      const size = Math.min(Math.max(Number(payload.page_size) || 25, 1), 100);
      const from = Number(payload.page_index ?? 0) * size;
      const chunk = { list: all.slice(from, from + size), total };
      if (delayMs === 0) return of(chunk);
      // Реальная задержка: бюджет времени считается по настенным часам.
      return new Observable((sub) => {
        const t = setTimeout(() => {
          sub.next(chunk);
          sub.complete();
        }, delayMs);
        return () => clearTimeout(t);
      });
    };
    return Object.assign(fn, { calls });
  }

  const csvOf = (buf: Buffer) => buf.toString('utf8').split('\n');

  it('без бюджета — 250 строк × 4 донора = 1000 одиночных RPC; с бюджетом их ровно столько, сколько разрешено', async () => {
    process.env.ORDERS_EXPORT_NAME_RPC_BUDGET = '12';
    const dir = directory();
    const ctrl = build({ orders: { listOrders: pagedOrders(250) }, ...dir.services });
    const r = res();

    const lines = csvOf(
      (await ctrl.exportOrders(gatedReq(), r as never, 'proj-1', 'csv')) as Buffer,
    );

    expect(dir.donorCalls()).toBe(12);
    // Строки выгружены ВСЕ — усечён только резолв имён, и об этом сказано.
    expect(r.headers['X-Export-Row-Count']).toBe('250');
    expect(r.headers['X-Export-Truncated']).toBe('false');
    expect(r.headers['X-Export-Names-Incomplete']).toBe('true');
    expect(lines[lines.length - 1]).toContain('# Часть имён');
    expect(lines[lines.length - 1]).toContain('исчерпан бюджет запросов');
  });

  it('бюджета хватило — имена резолвятся полностью и файл ничем не помечен', async () => {
    const dir = directory();
    const ctrl = build({ orders: { listOrders: pagedOrders(250) }, ...dir.services });
    const r = res();

    const lines = csvOf(
      (await ctrl.exportOrders(gatedReq(), r as never, 'proj-1', 'csv')) as Buffer,
    );

    expect(dir.donorCalls()).toBe(1000);
    expect(r.headers['X-Export-Names-Incomplete']).toBe('false');
    expect(lines.join('\n')).not.toContain('# Часть имён');
    expect(lines).toHaveLength(251);
  });

  it('JSON: неполный резолв имён виден служебным маркером, даже когда строки все', async () => {
    process.env.ORDERS_EXPORT_NAME_RPC_BUDGET = '0';
    const dir = directory();
    const ctrl = build({ orders: { listOrders: pagedOrders(150) }, ...dir.services });

    const buf = (await ctrl.exportOrders(gatedReq(), res() as never, 'proj-1', 'json')) as Buffer;
    const rows = JSON.parse(buf.toString('utf8')) as Record<string, unknown>[];

    expect(dir.donorCalls()).toBe(0);
    expect(rows).toHaveLength(151);
    expect(rows[150]).toMatchObject({
      _truncated: false,
      _exported: 150,
      _namesIncomplete: true,
    });
  });

  it('истёкший бюджет времени прерывает листание с обычным маркером усечения', async () => {
    process.env.ORDERS_EXPORT_BUDGET_MS = '1';
    const dir = directory();
    // 5 страниц по 100; каждая отвечает через 5 мс — бюджет истекает на первой же.
    const listOrders = pagedOrders(500, 5);
    const ctrl = build({ orders: { listOrders }, ...dir.services });
    const r = res();

    const lines = csvOf(
      (await ctrl.exportOrders(gatedReq(), r as never, 'proj-1', 'csv')) as Buffer,
    );

    // Первую страницу читаем всегда — пустой файл без единого запроса не выгрузка.
    expect(listOrders.calls).toHaveLength(1);
    expect(r.headers['X-Export-Row-Count']).toBe('100');
    expect(r.headers['X-Export-Truncated']).toBe('true');
    expect(lines.join('\n')).toContain('Выгружены первые 100 строк из 500');
    // Имена по исчерпанному времени тоже не резолвятся — и это сказано отдельно.
    expect(dir.donorCalls()).toBe(0);
    expect(r.headers['X-Export-Names-Incomplete']).toBe('true');
    expect(lines.join('\n')).toContain('истёк бюджет времени выгрузки');
  });
});

describe('GET /v1/orders/export — одновременные выгрузки ограничены (429)', () => {
  const csvOf = (buf: Buffer) => buf.toString('utf8').split('\n');

  /** Домен, чья страница «зависает», пока тест не отпустит `gate`. */
  function gatedOrders() {
    const gate = new Subject<unknown>();
    let finished = false;
    // После снятия «замка» домен отвечает сразу: подписка на уже завершённый
    // Subject не эмитит ничего и обрывалась бы EmptyError, а тест про слоты,
    // а не про поведение rxjs.
    const fn = () => (finished ? of({ list: [], total: 0 }) : gate.asObservable());
    return Object.assign(fn, {
      finish: () => {
        finished = true;
        gate.next({ list: [], total: 0 });
        gate.complete();
      },
    });
  }

  async function statusOf(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
    try {
      await p;
      return { status: 200 };
    } catch (e) {
      if (e instanceof HttpException) {
        const body = e.getResponse() as Record<string, unknown>;
        return { status: e.getStatus(), code: String(body.code ?? '') };
      }
      throw e;
    }
  }

  it('вторая выгрузка того же пользователя получает 429 с кодом и Retry-After', async () => {
    const listOrders = gatedOrders();
    const ctrl = build({ orders: { listOrders } });
    const first = ctrl.exportOrders(gatedReq(), res() as never, 'proj-1', 'csv');
    const r2 = res();

    const second = await statusOf(ctrl.exportOrders(gatedReq(), r2 as never, 'proj-1', 'csv'));

    expect(second).toEqual({ status: HttpStatus.TOO_MANY_REQUESTS, code: 'EXPORT_RATE_LIMITED' });
    expect(r2.headers['Retry-After']).toBe('30');
    listOrders.finish();
    await first;
  });

  it('слот освобождается после завершения — следующая выгрузка проходит', async () => {
    const listOrders = gatedOrders();
    const ctrl = build({ orders: { listOrders } });
    const first = ctrl.exportOrders(gatedReq(), res() as never, 'proj-1', 'csv');
    listOrders.finish();
    await first;

    const again = (await ctrl.exportOrders(gatedReq(), res() as never, 'proj-1', 'csv')) as Buffer;

    expect(csvOf(again)[0]).toContain('number');
  });

  it('упавшая выгрузка слот не удерживает (finally, а не happy path)', async () => {
    const calls: number[] = [];
    const failing = () => {
      calls.push(1);
      return throwError(() => ({ code: GrpcStatus.UNAVAILABLE, message: 'down' }));
    };
    const ctrl = build({ orders: { listOrders: failing } });
    await expect(
      ctrl.exportOrders(gatedReq(), res() as never, 'proj-1', 'csv'),
    ).rejects.toBeTruthy();

    const second = await ctrl
      .exportOrders(gatedReq(), res() as never, 'proj-1', 'csv')
      .then(() => null)
      .catch((e: unknown) => e);

    // Слот был свободен: запрос дошёл до домена (второй вызов listOrders) и упал
    // на нём же, а не отбился ограничителем как «выгрузка уже идёт».
    expect(calls).toHaveLength(2);
    expect(second).not.toBeInstanceOf(HttpException);
  });

  it('второй пользователь того же проекта не блокируется первым', async () => {
    const listOrders = gatedOrders();
    const ctrl = build({ orders: { listOrders } });
    const first = ctrl.exportOrders(gatedReq(), res() as never, 'proj-1', 'csv');

    const second = ctrl.exportOrders(
      gatedReq({ user: { userId: 'u2' } }),
      res() as never,
      'proj-1',
      'csv',
    );

    listOrders.finish();
    await expect(second).resolves.toBeInstanceOf(Buffer);
    await first;
  });

  it('третий пользователь того же проекта упирается в лимит проекта', async () => {
    const listOrders = gatedOrders();
    const ctrl = build({ orders: { listOrders } });
    const first = ctrl.exportOrders(gatedReq(), res() as never, 'proj-1', 'csv');
    const second = ctrl.exportOrders(
      gatedReq({ user: { userId: 'u2' } }),
      res() as never,
      'proj-1',
      'csv',
    );

    const third = await statusOf(
      ctrl.exportOrders(gatedReq({ user: { userId: 'u3' } }), res() as never, 'proj-1', 'csv'),
    );

    expect(third.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    listOrders.finish();
    await Promise.all([first, second]);
  });
});
