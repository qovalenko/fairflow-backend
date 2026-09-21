import {
  compileAggregateAccessPredicate,
  isAggregateRouteSubject,
} from './access-predicate.aggregate';
import { compileAccessPredicate, type AbacPolicyRule } from './access-predicate';
import { readAccessPredicate, GW_METADATA, type AbacEvalContext } from '@fairflow/shared';
import { Metadata } from '@grpc/grpc-js';

/**
 * Ревью волны «Статистика» (major): предикат ABAC для агрегатов компилировался
 * только по subject'у маршрута (`statistics`/`reports`), а применялся ко всем пяти
 * коллекциям-источникам. Правило на `deals` не сужало агрегат вовсе (в списке
 * сделка скрыта, а её сумма видна в статистике), а маршрутный фрагмент уезжал в
 * activities, где владелец называется иначе. Тест фиксирует набор по источникам.
 */
const CTX: AbacEvalContext = {
  user: {
    id: 'u1',
    departmentId: null,
    departmentChain: [],
    leaderOfDepartmentIds: [],
    role: 'member',
  },
  project: { id: 'p1', ownerType: 'ORGANIZATION', ownerId: 'org1' },
};

function decode(serialized: string | undefined): Record<string, unknown> {
  expect(serialized).toBeDefined();
  return JSON.parse(Buffer.from(String(serialized), 'base64').toString('utf8'));
}

const dealsRule: AbacPolicyRule = {
  effect: 'deny',
  subject: 'deals',
  action: 'read',
  resource: '*',
  condition: { op: 'gt', left: { ref: 'record.amount' }, right: { lit: 1_000_000 } },
};

const statisticsRule: AbacPolicyRule = {
  effect: 'allow',
  subject: 'statistics',
  action: 'read',
  resource: '*',
  condition: { op: 'eq', left: { ref: 'record.region' }, right: { lit: 'ru' } },
};

describe('compileAggregateAccessPredicate', () => {
  it('маршруты-агрегаты распознаются по subject (CRM-маршруты — нет)', () => {
    expect(isAggregateRouteSubject('statistics')).toBe(true);
    expect(isAggregateRouteSubject('reports')).toBe(true);
    expect(isAggregateRouteSubject('deals')).toBe(false);
  });

  it('правило на источник (deals) попадает в bySubject, хотя subject маршрута — statistics', () => {
    const payload = decode(
      compileAggregateAccessPredicate({
        rules: [dealsRule],
        subject: 'statistics',
        action: 'read',
        ctx: CTX,
      }),
    );
    const bySubject = payload.bySubject as Record<string, { mongo: Record<string, unknown> }>;
    expect(bySubject.deals.mongo).toEqual({
      $or: [{ $nor: [{ amount: { $gt: 1_000_000 } }] }, { ownerId: 'u1' }],
    });
    // Правил на сам `statistics` нет → маршрутного сужения нет (а не «всё скрыто»).
    expect(payload.mongo).toBeNull();
    // Фрагмент сделок НЕ уезжает в другие источники (иначе contacts/activities пустеют).
    expect(bySubject.contacts).toBeUndefined();
    expect(bySubject.activities).toBeUndefined();
  });

  it('фрагмент источника совпадает с тем, что получил бы его собственный маршрут', () => {
    const own = decode(
      compileAccessPredicate({ rules: [dealsRule], subject: 'deals', action: 'read', ctx: CTX }),
    );
    const aggregate = decode(
      compileAggregateAccessPredicate({
        rules: [dealsRule],
        subject: 'statistics',
        action: 'read',
        ctx: CTX,
      }),
    );
    const bySubject = aggregate.bySubject as Record<string, { mongo: Record<string, unknown> }>;
    expect(bySubject.deals.mongo).toEqual(own.mongo);
  });

  it('маршрутный предикат сохраняется рядом с набором источников', () => {
    const payload = decode(
      compileAggregateAccessPredicate({
        rules: [statisticsRule, dealsRule],
        subject: 'statistics',
        action: 'read',
        ctx: CTX,
      }),
    );
    expect(payload.mongo).toEqual({ region: { $eq: 'ru' } });
    expect((payload.bySubject as Record<string, unknown>).deals).toBeDefined();
  });

  it('источники берутся по действию read даже на export-маршруте', () => {
    const payload = decode(
      compileAggregateAccessPredicate({
        rules: [dealsRule],
        subject: 'statistics',
        action: 'export',
        ctx: CTX,
      }),
    );
    expect((payload.bySubject as Record<string, { mongo: unknown }>).deals.mongo).toEqual({
      $or: [{ $nor: [{ amount: { $gt: 1_000_000 } }] }, { ownerId: 'u1' }],
    });
  });

  it('безусловный deny на источник закрывает его данные в агрегате (KPI других источников живы)', () => {
    // Правило `deny activities:read` без условия: на своём маршруте это 403
    // (isDeniedByPolicy), а в дашборде до фикса продолжали ехать overdue/upcoming/
    // recent — id, заголовки и владельцы тех же активностей.
    const payload = decode(
      compileAggregateAccessPredicate({
        rules: [
          { effect: 'deny', subject: 'activities', action: 'read', resource: '*' },
          dealsRule,
        ],
        subject: 'statistics',
        action: 'read',
        ctx: CTX,
      }),
    );
    const bySubject = payload.bySubject as Record<string, { mongo: Record<string, unknown> }>;
    // Фрагмент «не матчит ничего» — предикатом в БД, а не фильтрацией в памяти.
    expect(bySubject.activities.mongo).toEqual({ _id: { $in: [] } });
    // Сделки закрыты не сплошь, а построчно — своим условным правилом.
    expect(bySubject.deals.mongo).toEqual({
      $or: [{ $nor: [{ amount: { $gt: 1_000_000 } }] }, { ownerId: 'u1' }],
    });
    // Соседние источники не задеты: запрет адресный.
    expect(bySubject.contacts).toBeUndefined();
    expect(bySubject.orders).toBeUndefined();
  });

  it('безусловный deny доезжает и на export-маршруте (выгрузка не шире экрана)', () => {
    const payload = decode(
      compileAggregateAccessPredicate({
        rules: [{ effect: 'deny', subject: 'deals', action: 'read' }],
        subject: 'statistics',
        action: 'export',
        ctx: CTX,
      }),
    );
    expect((payload.bySubject as Record<string, { mongo: unknown }>).deals.mongo).toEqual({
      _id: { $in: [] },
    });
  });

  it('безусловный deny перекрывает построчное сужение того же источника (deny > allow)', () => {
    const payload = decode(
      compileAggregateAccessPredicate({
        rules: [
          {
            effect: 'allow',
            subject: 'deals',
            action: 'read',
            resource: '*',
            condition: { op: 'eq', left: { ref: 'record.region' }, right: { lit: 'ru' } },
          },
          { effect: 'deny', subject: 'deals', action: 'read', resource: '*' },
        ],
        subject: 'statistics',
        action: 'read',
        ctx: CTX,
      }),
    );
    expect((payload.bySubject as Record<string, { mongo: unknown }>).deals.mongo).toEqual({
      _id: { $in: [] },
    });
  });

  it('безусловный ALLOW источником не считается (это не запрет, сужать нечем)', () => {
    expect(
      compileAggregateAccessPredicate({
        rules: [{ effect: 'allow', subject: 'activities', action: 'read', resource: '*' }],
        subject: 'statistics',
        action: 'read',
        ctx: CTX,
      }),
    ).toBeUndefined();
  });

  it('нечего сужать → значение не формируется (заголовок отсутствует, как и раньше)', () => {
    expect(
      compileAggregateAccessPredicate({
        rules: [{ effect: 'allow', subject: 'deals', action: 'read', resource: '*' }],
        subject: 'statistics',
        action: 'read',
        ctx: CTX,
      }),
    ).toBeUndefined();
  });

  it('старый читатель (shared readAccessPredicate) конверт не ломает: bySubject игнорируется', () => {
    const value = compileAggregateAccessPredicate({
      rules: [dealsRule],
      subject: 'statistics',
      action: 'read',
      ctx: CTX,
    });
    const m = new Metadata();
    m.set(GW_METADATA.ACCESS_PREDICATE, String(value));
    // mongo=null и ir=null → «ABAC-сужения нет», ровно как при отсутствии заголовка;
    // никакого malformed/deny-all у доменов, которые про bySubject не знают.
    expect(readAccessPredicate(m)).toEqual({ present: false });
  });
});
