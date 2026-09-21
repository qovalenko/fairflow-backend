import { randomUUID } from 'node:crypto';
import { Metadata } from '@grpc/grpc-js';
import {
  GW_METADATA,
  buildGatewayOutboundMetadata,
  serializeVisibilityScope,
} from '@fairflow/shared';
import type { VisibilityScope } from '@fairflow/shared';
import { ReportsGrpcController } from './reports.grpc.controller';

/** Server-minted call id — same wire key as shared GW_METADATA.CALL_ID (P8 wave). */
const GW_CALL_ID = 'x-gw-call-id';

/**
 * TODO-112 / TODO-495: гарантия «у метадаты есть читатель».
 *
 * Класс дефектов прошлой волны — «домен умеет, а до пользователя не доходит»:
 * gateway компилировал ABAC-предикат и резолвил набор включённых модулей, клал
 * их в метадату, а контроллер reports читал оттуда только visibility-scope. Тест
 * проверяет транспортный стык: каждый заголовок доезжает до сервиса аргументом.
 */
describe('ReportsGrpcController → ReportsService: чтение метадаты', () => {
  const scope: VisibilityScope = {
    mode: 'restricted',
    level: 'only_own',
    selfId: 'u1',
    ownerIds: ['u1'],
    sharedRecordIds: [],
  } as VisibilityScope;

  const predicate = Buffer.from(
    JSON.stringify({ mongo: { region: 'ru' }, ir: null }),
    'utf8',
  ).toString('base64');

  function metadata(): Metadata {
    const m = new Metadata();
    m.set(GW_METADATA.PROJECT_ID, 'p1');
    m.set(GW_METADATA.USER_ID, 'u1');
    m.set(GW_METADATA.VISIBILITY_SCOPE, serializeVisibilityScope(scope));
    m.set(GW_METADATA.ACCESS_PREDICATE, predicate);
    m.set(GW_METADATA.ENABLED_MODULES, JSON.stringify(['statistics', 'deals']));
    return m;
  }

  function controller() {
    const calls: Record<string, unknown[]> = {};
    const service = new Proxy(
      {},
      {
        get:
          (_t, prop: string) =>
          (...args: unknown[]) => {
            calls[prop] = args;
            return Promise.resolve({});
          },
      },
    );
    return {
      ctl: new ReportsGrpcController(service as never, { recordModuleRequest: jest.fn() } as never),
      calls,
    };
  }

  it('GetDashboard получает и enabledModules, и ABAC-предикат', async () => {
    const { ctl, calls } = controller();
    await ctl.getDashboard({ period: 'month' }, metadata());
    const [, , , , gotScope, gotModules, gotAccess] = calls.getDashboard;
    expect((gotScope as VisibilityScope).ownerIds).toEqual(['u1']);
    expect(gotModules).toEqual(['statistics', 'deals']);
    expect(gotAccess).toMatchObject({ present: true, mongo: { region: 'ru' } });
  });

  it('GetMetrics получает ABAC-предикат восьмым аргументом (модули читались и раньше)', async () => {
    const { ctl, calls } = controller();
    await ctl.getMetrics({ period: 'month', slices: ['funnel'] }, metadata());
    expect(calls.getMetrics[6]).toEqual(['statistics', 'deals']);
    expect(calls.getMetrics[7]).toMatchObject({ present: true, mongo: { region: 'ru' } });
  });

  it('RunReport/ExportReport/DrillReport тоже получают предикат', async () => {
    const { ctl, calls } = controller();
    await ctl.run({ id: 'r1' }, metadata());
    await ctl.export({ id: 'r1' }, metadata());
    await ctl.drill({ id: 'r1', dimension: 'stage_id', value: 's1' }, metadata());
    expect(calls.run[6]).toMatchObject({ present: true });
    expect(calls.export[6]).toMatchObject({ present: true });
    expect(calls.drill[8]).toMatchObject({ present: true });
  });

  it('TODO-475: серверный x-gw-call-id доезжает до run/export аргументом', async () => {
    const { ctl, calls } = controller();
    const m = metadata();
    m.set(GW_CALL_ID, 'call-42');
    await ctl.run({ id: 'r1' }, m);
    await ctl.export({ id: 'r1' }, m);
    expect(calls.run[7]).toBe('call-42');
    expect(calls.export[7]).toBe('call-42');
  });

  it('TODO-475: клиентские idempotency-key/x-request-id ключом аудита НЕ становятся', async () => {
    // Оба заголовка контролирует клиент (gateway echo-ит x-request-id как есть),
    // а audit дедуплицирует по ключу 7 суток: возьми их — и `for i in $(seq 100)`
    // с фиксированным X-Request-Id оставит в журнале ОДИН факт (регресс FR-MSTAT-23).
    const { ctl, calls } = controller();
    const m = metadata();
    m.set(GW_METADATA.REQUEST_ID, 'rid-42');
    m.set(GW_METADATA.IDEMPOTENCY_KEY, 'client-key-7');
    await ctl.run({ id: 'r1' }, m);
    await ctl.export({ id: 'r1' }, m);
    expect(calls.run[7]).toBeUndefined();
    expect(calls.export[7]).toBeUndefined();
  });

  it('TODO-475: серверный call-id выигрывает у клиентских заголовков', async () => {
    const { ctl, calls } = controller();
    const m = metadata();
    m.set(GW_METADATA.REQUEST_ID, 'rid-42');
    m.set(GW_METADATA.IDEMPOTENCY_KEY, 'client-key-7');
    m.set(GW_CALL_ID, 'call-9');
    await ctl.run({ id: 'r1' }, m);
    expect(calls.run[7]).toBe('call-9');
  });

  it('TODO-475: без call-id в сервис уезжает undefined (а не пустая строка)', async () => {
    const { ctl, calls } = controller();
    await ctl.run({ id: 'r1' }, metadata());
    expect(calls.run[7]).toBeUndefined();
  });

  it('TODO-475: два экспорта с ОДНИМ клиентским X-Request-Id — два разных ключа', async () => {
    // Сквозной стык: метадата собирается настоящим gateway-билдером. Клиент
    // фиксирует X-Request-Id (`for i in $(seq 100); do curl -H 'X-Request-Id: fixed' …`),
    // но ключ дедупликации факта берётся из серверного call-id, поэтому в журнале
    // остаются оба факта statistics.exported (FR-MSTAT-23 — неотказуемость).
    const headers = { 'x-request-id': 'fixed', 'idempotency-key': 'fixed-idem' };
    const build = () => {
      const m = buildGatewayOutboundMetadata({
        serviceApiKey: 'ak_test',
        gatewayApiKeyId: 'kid',
        headers,
        actorType: 'user',
        userId: 'u1',
        projectId: 'p1',
        visibilityScope: serializeVisibilityScope(scope),
      });
      // Gateway mints a fresh call-id per outbound build (shared P8 wave); simulate here.
      m.set(GW_CALL_ID, randomUUID());
      return m;
    };
    const { ctl, calls } = controller();
    await ctl.export({ id: 'r1', format: 'csv' }, build());
    const first = calls.export[7];
    await ctl.export({ id: 'r1', format: 'csv' }, build());
    const second = calls.export[7];
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    expect(first).not.toBe('fixed');
    expect(first).not.toBe('fixed-idem');
  });

  it('битый предикат доезжает как malformed (домен обязан ответить deny-all)', async () => {
    const { ctl, calls } = controller();
    const m = metadata();
    m.set(GW_METADATA.ACCESS_PREDICATE, 'not-a-base64-json!!');
    await ctl.getDashboard({ period: 'month' }, m);
    expect(calls.getDashboard[6]).toMatchObject({ present: true, malformed: true });
  });
});

/**
 * TODO-466 (FR-REPORTS-390): транспортный стык уровня доступа определения отчёта.
 *
 * У доменного гейта `visibility='personal' → виден только createdBy` два входа,
 * и оба идут через этот контроллер: значение поля из запроса (create/update) и
 * ЛИЧНОСТЬ ЗРИТЕЛЯ из метадаты (`x-user-id`) — во все CRUD-методы и в drill.
 * Забыть один аргумент здесь = вернуть ровно тот дефект, ради которого поле
 * заводили: домен умеет разграничивать, а до вызова это не доезжает. userId
 * берётся ТОЛЬКО из метадаты — тело запроса на него влиять не может.
 */
describe('TODO-466: контроллер отдаёт домену visibility и личность зрителя', () => {
  function metaWithUser(userId?: string): Metadata {
    const m = new Metadata();
    m.set(GW_METADATA.PROJECT_ID, 'p1');
    if (userId) m.set(GW_METADATA.USER_ID, userId);
    return m;
  }

  function controller() {
    const calls: Record<string, unknown[]> = {};
    const service = new Proxy(
      {},
      {
        get:
          (_t, prop: string) =>
          (...args: unknown[]) => {
            calls[prop] = args;
            return Promise.resolve({});
          },
      },
    );
    return {
      ctl: new ReportsGrpcController(service as never, { recordModuleRequest: jest.fn() } as never),
      calls,
    };
  }

  it('ListReports/GetReport/DeleteReport получают зрителя из x-user-id', async () => {
    const { ctl, calls } = controller();
    await ctl.list({ project_id: 'p1' }, metaWithUser('u1'));
    await ctl.get({ project_id: 'p1', id: 'r1' }, metaWithUser('u1'));
    await ctl.remove({ project_id: 'p1', id: 'r1' }, metaWithUser('u1'));
    expect(calls.list[4]).toBe('u1');
    expect(calls.get[2]).toBe('u1');
    expect(calls.remove[2]).toBe('u1');
  });

  it('CreateReport везёт и автора, и выбранный уровень доступа', async () => {
    const { ctl, calls } = controller();
    await ctl.create(
      { project_id: 'p1', name: 'Мой отчёт', visibility: 'personal' },
      metaWithUser('u1'),
    );
    expect(calls.create[5]).toBe('u1');
    expect(calls.create[6]).toBe('personal');
  });

  it('UpdateReport везёт новый уровень доступа и зрителя (гейт записи = гейт чтения)', async () => {
    const { ctl, calls } = controller();
    await ctl.update({ project_id: 'p1', id: 'r1', visibility: 'project' }, metaWithUser('u1'));
    expect(calls.update[5]).toBe('project');
    expect(calls.update[6]).toBe('u1');
  });

  it('DrillReport тоже проходит гейт — иначе личный отчёт разворачивался бы по прямому id', async () => {
    const { ctl, calls } = controller();
    await ctl.drill({ project_id: 'p1', id: 'r1', dimension: 'stage_id' }, metaWithUser('u1'));
    expect(calls.drill[9]).toBe('u1');
  });

  it('без x-user-id зритель НЕ подменяется пустой строкой — домен закрывается сам', async () => {
    const { ctl, calls } = controller();
    await ctl.list({ project_id: 'p1' }, metaWithUser());
    await ctl.get({ project_id: 'p1', id: 'r1' }, metaWithUser());
    expect(calls.list[4]).toBeFalsy();
    expect(calls.get[2]).toBeFalsy();
  });
});
