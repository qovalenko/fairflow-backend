import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSync, type Options } from '@grpc/proto-loader';
import { of } from 'rxjs';
import { toNum, grpcBffCall } from './grpc-bff-call';

/**
 * Component coverage (QA-CI T-036.3) for the BFF response coercions that
 * grpc-bff-call.spec.ts (deadline behaviour) does not touch: the canonical
 * int64/Long → number helper `toNum`, and the ms→seconds timestamp rewriting
 * (`msTimestampsToSeconds`, exercised through grpcBffCall's result mapping).
 * Getting these wrong sends dates to the ~58000 year and breaks every FE
 * `dayjs.unix` render, so they are worth pinning explicitly.
 */

// protobuf Long as @grpc/grpc-js decodes int64 ({low, high, unsigned}).
const long = (n: number) => ({
  low: n & 0xffffffff,
  high: Math.floor(n / 0x1_0000_0000),
  unsigned: false,
});

describe('toNum (int64/Long → number)', () => {
  it('returns 0 for null/undefined', () => {
    expect(toNum(null)).toBe(0);
    expect(toNum(undefined)).toBe(0);
  });

  it('passes a plain number through', () => {
    expect(toNum(42)).toBe(42);
    expect(toNum(0)).toBe(0);
  });

  it('parses a numeric string, and returns 0 for a non-numeric one', () => {
    expect(toNum('123')).toBe(123);
    expect(toNum('not-a-number')).toBe(0);
  });

  it('decodes a protobuf Long {low, high} into a plain number', () => {
    expect(toNum(long(1_750_800_000_000))).toBe(1_750_800_000_000);
    expect(toNum({ low: 42, high: 0, unsigned: false })).toBe(42);
  });

  it('returns 0 for an unrecognised object shape', () => {
    expect(toNum({ foo: 'bar' })).toBe(0);
    expect(toNum(true)).toBe(0);
  });
});

describe('grpcBffCall — ms→seconds timestamp rewriting', () => {
  it('converts known ms timestamp keys to unix seconds', async () => {
    const created = 1_712_000_000_000; // ms
    const res = await grpcBffCall(of({ id: 'd1', created_at: created, name: 'x' }), 50);
    expect(res).toEqual({ id: 'd1', created_at: Math.floor(created / 1000), name: 'x' });
  });

  it('leaves values already in the seconds range untouched', async () => {
    const seconds = 1_712_000_000; // already seconds (< 1e11)
    const res = (await grpcBffCall(of({ updated_at: seconds }), 50)) as { updated_at: number };
    expect(res.updated_at).toBe(seconds);
  });

  it('decodes a Long timestamp then divides ms→seconds', async () => {
    const ms = 1_750_800_000_000;
    const res = (await grpcBffCall(of({ closed_at: long(ms) }), 50)) as unknown as {
      closed_at: number;
    };
    expect(res.closed_at).toBe(Math.floor(ms / 1000));
  });

  it('recurses into nested objects and arrays', async () => {
    const ms = 1_712_000_000_000;
    const res = (await grpcBffCall(
      of({ list: [{ due_date: ms, meta: { start_date: ms } }] }),
      50,
    )) as { list: { due_date: number; meta: { start_date: number } }[] };
    expect(res.list[0].due_date).toBe(Math.floor(ms / 1000));
    expect(res.list[0].meta.start_date).toBe(Math.floor(ms / 1000));
  });

  it('does not touch non-timestamp fields', async () => {
    const res = (await grpcBffCall(of({ amount: 1_712_000_000_000, title: 'deal' }), 50)) as {
      amount: number;
      title: string;
    };
    // `amount` is not a timestamp key → left as-is even though it is > 1e11.
    expect(res.amount).toBe(1_712_000_000_000);
    expect(res.title).toBe('deal');
  });

  it("resolves the 'write' deadline kind without timing out", async () => {
    const res = await grpcBffCall(of({ ok: true }), 'write');
    expect(res).toEqual({ ok: true });
  });

  it("resolves the default 'read' deadline kind", async () => {
    const res = await grpcBffCall(of({ ok: true }));
    expect(res).toEqual({ ok: true });
  });
});

/**
 * ГРАНИЦА int64 (волна 2026-08-17, группа А) — четвёртая ипостась грабли
 * «gRPC-loader без полных опций молча теряет данные».
 *
 * `@grpc/proto-loader` без `longs: Number` декодирует КАЖДОЕ int64-поле в объект
 * `Long {low, high, unsigned}`, а TypeScript видит объявленный `number` и молчит.
 * Объект переживает JSON-ответ BFF и BSON-запись в Mongo уже без прототипа →
 * `Number(v)` = NaN, `new Date(v)`/`dayjs.unix(v)` = Invalid Date. Так пропадали
 * дата закрытия сделки (FR-DEALS-010), бейдж просрочки (FR-DEALS-096), календарь
 * активностей и колонка «Время» в попытках финального действия заказа.
 *
 * Тест гоняет РЕАЛЬНЫЕ proto проекта через serialize/deserialize и требует число
 * на обоих концах провода — и в запросе gateway → домен, и в ответе домен → gateway.
 * tsc такую регрессию не ловит принципиально, поэтому проверка только тут.
 */
describe('int64 на проводе: gateway ↔ домены отдают number, а не Long', () => {
  const protoFile = (...p: string[]) =>
    join(__dirname, '..', '..', '..', 'proto', 'fairflow', ...p);

  /** Опции gateway-клиентов из grpc-bff.module.ts (keepCase/arrays — не трогать). */
  const GATEWAY_LOADER = { keepCase: true, arrays: true, longs: Number };
  /** Как было до правки — оставлено, чтобы грабля осталась исполняемой. */
  const LOADER_WITHOUT_LONGS = { keepCase: true, arrays: true };

  type Serde = {
    requestSerialize: (v: unknown) => Buffer;
    requestDeserialize: (b: Buffer) => Record<string, unknown>;
    responseSerialize: (v: unknown) => Buffer;
    responseDeserialize: (b: Buffer) => Record<string, unknown>;
  };
  const methodSerde = (
    file: string,
    serviceFq: string,
    method: string,
    options: Options,
  ): Serde => {
    const def = loadSync(file, options);
    return (def[serviceFq] as unknown as Record<string, Serde>)[method];
  };

  it('ЗАПРОС: pipe UpdateDeal.expected_close_date (секунды) доезжает числом', () => {
    const secs = 1_781_000_000; // ~2026 в СЕКУНДАХ — ниже любого ms-порога
    const serde = methodSerde(
      protoFile('pipe', 'v1', 'pipe.proto'),
      'fairflow.pipe.v1.PipeGrpc',
      'UpdateDeal',
      GATEWAY_LOADER,
    );
    const back = serde.requestDeserialize(
      serde.requestSerialize({ project_id: 'p1', id: 'd1', expected_close_date: secs }),
    );
    expect(typeof back.expected_close_date).toBe('number');
    expect(back.expected_close_date).toBe(secs);
  });

  it('ОТВЕТ: activity CalendarEvent.start/end доезжают числами и дают валидную дату', () => {
    const ms = 1_755_000_000_000;
    const serde = methodSerde(
      protoFile('activity', 'v1', 'activity.proto'),
      'fairflow.activity.v1.ActivityGrpc',
      'ListActivitiesCalendar',
      GATEWAY_LOADER,
    );
    const back = serde.responseDeserialize(
      serde.responseSerialize({
        events: [{ id: 'a1', title: 't', start: ms, end: ms + 3_600_000 }],
      }),
    );
    const ev = (back.events as Record<string, unknown>[])[0];
    expect(typeof ev.start).toBe('number');
    expect(typeof ev.end).toBe('number');
    expect(new Date(ev.start as number).toISOString()).toBe(new Date(ms).toISOString());
  });

  it('ОТВЕТ: orders final_action_state.succeeded_at / attempts[].at доезжают числами', () => {
    const serde = methodSerde(
      protoFile('orders', 'v1', 'orders.proto'),
      'fairflow.orders.v1.OrdersGrpc',
      'GetOrder',
      GATEWAY_LOADER,
    );
    const back = serde.responseDeserialize(
      serde.responseSerialize({
        id: 'o1',
        final_action_state: {
          status: 'SUCCEEDED',
          succeeded_at: 1_755_000_222_000,
          attempts: [{ at: 1_755_000_111_000, attempt_no: 1 }],
        },
      }),
    );
    const st = back.final_action_state as Record<string, unknown>;
    expect(typeof st.succeeded_at).toBe('number');
    expect(st.succeeded_at).toBe(1_755_000_222_000);
    const at = (st.attempts as Record<string, unknown>[])[0].at;
    expect(typeof at).toBe('number');
    expect(at).toBe(1_755_000_111_000);
  });

  it('ФИКСИРУЕТ ГРАБЛЮ: без longs:Number то же поле приезжает объектом Long', () => {
    const serde = methodSerde(
      protoFile('activity', 'v1', 'activity.proto'),
      'fairflow.activity.v1.ActivityGrpc',
      'ListActivitiesCalendar',
      LOADER_WITHOUT_LONGS,
    );
    const back = serde.responseDeserialize(
      serde.responseSerialize({ events: [{ id: 'a1', start: 1_755_000_000_000 }] }),
    );
    const start = (back.events as Record<string, unknown>[])[0].start;
    expect(typeof start).toBe('object');
    // Ровно то, что видел фронт: после JSON прототип long.js теряется.
    const afterJson = JSON.parse(JSON.stringify(start)) as unknown;
    expect(Number(afterJson)).toBeNaN();
  });

  it('grpc-bff.module.ts действительно объявляет longs: Number', () => {
    const mod = readFileSync(join(__dirname, 'grpc-bff.module.ts'), 'utf8');
    expect(mod).toContain('longs: Number');
    // keepCase/arrays — несущие, теряться не должны.
    expect(mod).toContain('keepCase: true');
    expect(mod).toContain('arrays: true');
  });
});

describe('msTimestampsToSeconds: наружу всегда число (или нетронутая ISO-строка)', () => {
  it('метка в СЕКУНДАХ, приехавшая Long, разворачивается в число и не делится', async () => {
    const secs = 1_781_000_000; // < 1e11 → уже секунды
    const res = (await grpcBffCall(of({ expected_close_date: long(secs) }), 50)) as unknown as {
      expected_close_date: number;
    };
    expect(typeof res.expected_close_date).toBe('number');
    expect(res.expected_close_date).toBe(secs);
  });

  it('Long вне TS_KEYS (total, at) тоже разворачивается — фронт объект не понимает', async () => {
    const res = (await grpcBffCall(
      of({ total: long(12_345), at: long(1_755_000_111_000) }),
      50,
    )) as unknown as {
      total: number;
      at: number;
    };
    expect(res.total).toBe(12_345);
    expect(res.at).toBe(1_755_000_111_000);
  });

  it('ISO-строку в timestamp-поле (auth/control отдают string created_at) не портит', async () => {
    const iso = '2026-08-15T10:00:00.000Z';
    const res = (await grpcBffCall(of({ created_at: iso }), 50)) as { created_at: string };
    expect(res.created_at).toBe(iso);
  });

  it('отсутствующую метку не подменяет нулём', async () => {
    const res = (await grpcBffCall(of({ closed_at: null, due_date: undefined }), 50)) as {
      closed_at: unknown;
      due_date: unknown;
    };
    expect(res.closed_at).toBeNull();
    expect(res.due_date).toBeUndefined();
  });

  it('числовую строку из loader-а с longs:String приводит к числу и делит мс→сек', async () => {
    const ms = 1_755_000_000_000;
    const res = (await grpcBffCall(of({ created_at: String(ms) }), 50)) as unknown as {
      created_at: number;
    };
    expect(res.created_at).toBe(Math.floor(ms / 1000));
  });
});
