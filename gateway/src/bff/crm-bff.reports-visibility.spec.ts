/**
 * TODO-466 (FR-REPORTS-390) — уровень доступа отчёта едет ОТДЕЛЬНЫМ полем, а не
 * строкой описания.
 *
 * Дефект: конструктор отчётов увозил выбор радиокнопки «Личный/Проектный» в
 * `description` (`ReportBuilder.tsx:169`), потому что ни в контракте
 * (`proto/fairflow/reports/v1/reports.proto`), ни в BFF-проекции поля видимости
 * не было вовсе. Итог — уровень доступа не хранился нигде, и «личный» отчёт
 * возвращался всем участникам проекта.
 *
 * Здесь закрыта доля gateway: поле объявлено в контракте (переживает провод в
 * ОБЕ стороны) и домаплено на обоих концах BFF — запрос (create/update) и ответ
 * (list/get/create/update). Доменная половина (хранение в ReportDoc + фильтр
 * `visibility='project' OR createdBy=userId` в list/get) — в reports.
 */
import { join } from 'node:path';
import { loadSync, type Options } from '@grpc/proto-loader';
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
    {} as never, // reportRunNames (в CRUD-сценариях не участвует)
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = { user: { userId: 'u1' }, headers: {} } as never;

/** Определение отчёта в том виде, в каком его отдаёт домен (loader keepCase). */
function wireReport(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    project_id: 'p1',
    name: 'Мой отчёт',
    description: 'Сделки за квартал',
    kind: 'custom',
    preset_key: '',
    visibility: 'personal',
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe('TODO-466 — visibility в ответе домен → FE', () => {
  it('GET /v1/reports отдаёт visibility каждой строки списка', async () => {
    const listReports = () =>
      of({
        list: [wireReport(), wireReport({ id: 'r2', visibility: 'project' })],
        total: 2,
      });
    const ctrl = build({ listReports });

    const res = (await ctrl.listReports(req, 'p1')) as {
      list: { id: string; visibility: string }[];
    };
    expect(res.list.map((r) => [r.id, r.visibility])).toEqual([
      ['r1', 'personal'],
      ['r2', 'project'],
    ]);
  });

  it('GET /v1/reports/:id отдаёт visibility карточки', async () => {
    const getReport = () => of(wireReport());
    const ctrl = build({ getReport });

    const res = (await ctrl.getReport(req, 'r1', 'p1')) as { visibility: string };
    expect(res.visibility).toBe('personal');
  });

  it('пустая строка с провода (старая сборка домена) читается как project, а не как personal', async () => {
    // Ключевой инвариант деградации: отсутствие поля НЕ должно неожиданно
    // «прятать» существующие отчёты — AS-IS они были проектными.
    const getReport = () => of(wireReport({ visibility: '' }));
    const ctrl = build({ getReport });

    const res = (await ctrl.getReport(req, 'r1', 'p1')) as { visibility: string };
    expect(res.visibility).toBe('project');
  });

  it('неизвестное значение с провода нормализуется в project', async () => {
    const getReport = () => of(wireReport({ visibility: 'PERSONAL_V2' }));
    const ctrl = build({ getReport });

    const res = (await ctrl.getReport(req, 'r1', 'p1')) as { visibility: string };
    expect(res.visibility).toBe('project');
  });

  it('description остаётся описанием — уровень доступа его больше не занимает', async () => {
    const getReport = () => of(wireReport({ description: 'Сделки за квартал' }));
    const ctrl = build({ getReport });

    const res = (await ctrl.getReport(req, 'r1', 'p1')) as {
      description: string;
      visibility: string;
    };
    expect(res.description).toBe('Сделки за квартал');
    expect(res.visibility).toBe('personal');
  });
});

describe('TODO-466 — visibility в запросе FE → домен', () => {
  /** Перехват payload'а, уехавшего в домен (typed — без jest.fn()-дженериков). */
  function capture(method: 'createReport' | 'updateReport', reply: Record<string, unknown>) {
    const sent: Record<string, unknown>[] = [];
    const ctrl = build({
      [method]: (payload: Record<string, unknown>) => {
        sent.push(payload);
        return of(reply);
      },
    });
    return { ctrl, sent };
  }

  it('POST /v1/reports передаёт выбранный уровень доступа в домен', async () => {
    const { ctrl, sent } = capture('createReport', wireReport());

    await ctrl.createReport(
      req,
      { name: 'Мой отчёт', description: 'Сделки за квартал', visibility: 'personal' },
      'p1',
    );

    expect(sent[0]).toMatchObject({
      project_id: 'p1',
      visibility: 'personal',
      description: 'Сделки за квартал',
    });
  });

  it('POST без visibility создаёт проектный отчёт (дефолт = поведение до правки)', async () => {
    const { ctrl, sent } = capture('createReport', wireReport({ visibility: 'project' }));

    await ctrl.createReport(req, { name: 'Мой отчёт' }, 'p1');

    expect(sent[0]).toMatchObject({ visibility: 'project' });
  });

  it('мусорное значение в теле не уезжает в домен — создаётся проектный отчёт', async () => {
    const { ctrl, sent } = capture('createReport', wireReport({ visibility: 'project' }));

    await ctrl.createReport(req, { name: 'Мой отчёт', visibility: 'personal; drop' }, 'p1');

    expect(sent[0]).toMatchObject({ visibility: 'project' });
  });

  it('PATCH со сменой уровня доступа передаёт его в домен', async () => {
    const { ctrl, sent } = capture('updateReport', wireReport({ visibility: 'project' }));

    const res = (await ctrl.updateReport(req, 'r1', 'p1', { visibility: 'project' })) as {
      visibility: string;
    };

    expect(sent[0]).toMatchObject({ id: 'r1', visibility: 'project' });
    expect(res.visibility).toBe('project');
  });

  it('PATCH без visibility НЕ шлёт значения — личный отчёт не расшаривается переименованием', async () => {
    const { ctrl, sent } = capture('updateReport', wireReport());

    await ctrl.updateReport(req, 'r1', 'p1', { name: 'Новое имя' });

    // undefined → на проводе пустая строка → домен трактует как «не менять».
    expect(sent[0].visibility).toBeUndefined();
  });
});

/**
 * Новое поле контракта обязано пережить провод: без объявления в .proto
 * protobuf.js молча выбрасывает его при сериализации (та же грабля, что с
 * `snapshot` в pipe — TODO-185), и ни tsc, ни stub-тесты выше этого не видят.
 */
describe('TODO-466 — visibility переживает сериализацию reports.proto', () => {
  const protoFile = join(
    __dirname,
    '..',
    '..',
    '..',
    'proto',
    'fairflow',
    'reports',
    'v1',
    'reports.proto',
  );
  /** Опции gateway-клиентов из grpc-bff.module.ts. */
  const GATEWAY_LOADER: Options = { keepCase: true, arrays: true, longs: Number };

  type Serde = {
    requestSerialize: (v: unknown) => Buffer;
    requestDeserialize: (b: Buffer) => Record<string, unknown>;
    responseSerialize: (v: unknown) => Buffer;
    responseDeserialize: (b: Buffer) => Record<string, unknown>;
  };
  const serde = (method: string): Serde => {
    const def = loadSync(protoFile, GATEWAY_LOADER);
    return (def['fairflow.reports.v1.ReportsGrpc'] as unknown as Record<string, Serde>)[method];
  };

  it('ЗАПРОС CreateReport.visibility доезжает до домена', () => {
    const s = serde('CreateReport');
    const back = s.requestDeserialize(
      s.requestSerialize({ project_id: 'p1', name: 'r', visibility: 'personal' }),
    );
    expect(back.visibility).toBe('personal');
  });

  it('ЗАПРОС UpdateReport.visibility доезжает до домена', () => {
    const s = serde('UpdateReport');
    const back = s.requestDeserialize(
      s.requestSerialize({ project_id: 'p1', id: 'r1', visibility: 'project' }),
    );
    expect(back.visibility).toBe('project');
  });

  it('ОТВЕТ Report.visibility доезжает до gateway (list и get)', () => {
    const list = serde('ListReports');
    const back = list.responseDeserialize(
      list.responseSerialize({ list: [{ id: 'r1', visibility: 'personal' }], total: 1 }),
    );
    expect((back.list as Record<string, unknown>[])[0].visibility).toBe('personal');

    const get = serde('GetReport');
    const one = get.responseDeserialize(
      get.responseSerialize({ id: 'r1', visibility: 'personal' }),
    );
    expect(one.visibility).toBe('personal');
  });
});
