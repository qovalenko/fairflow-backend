import 'reflect-metadata';
import { compileAccessPredicate, type AbacPolicyRule } from './access-predicate';
import { parseCompiledPredicate, type AbacEvalContext } from '@fairflow/shared';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import { StatisticsBffController } from '../bff/statistics-bff.controller';

/**
 * Обход ABAC-сужения сменой маршрута (замечание ревью по TODO-112).
 *
 * Экран аналитики объявлен как `@RequirePermission('statistics','read')`, а
 * выгрузка — как `('statistics','export')`. Правило политики админ пишет на
 * `statistics:read` (именно такую пару валидирует каталог прав), поэтому на
 * export-маршруте предикат раньше не компилировался: заголовок
 * `x-access-predicate` отсутствовал → `accessMatch` в reports возвращал null →
 * CSV/JSON за тот же период отдавал БОЛЬШЕ строк, чем показывал экран.
 *
 * Здесь зафиксировано: export — это read в другом представлении, поэтому в
 * предикат идут И правила своего действия, И правила `read`; сужение только
 * усиливается (фрагменты AND-ятся), а RBAC-гейт остаётся на `export`.
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

const READ_RULE: AbacPolicyRule = {
  effect: 'allow',
  subject: 'statistics',
  action: 'read',
  resource: '*',
  condition: { op: 'eq', left: { ref: 'record.ownerId' }, right: { ref: 'user.id' } },
};

const EXPORT_RULE: AbacPolicyRule = {
  effect: 'deny',
  subject: 'statistics',
  action: 'export',
  resource: '*',
  condition: { op: 'eq', left: { ref: 'record.confidential' }, right: { lit: true } },
};

function mongoOf(serialized: string | undefined) {
  expect(serialized).toBeDefined();
  return parseCompiledPredicate(serialized).mongo;
}

describe('ABAC-предикат на read-образных маршрутах (export)', () => {
  it('маршрут /statistics/export действительно объявлен как statistics:export, а экран — как read', () => {
    // Якорь: если действия маршрутов поменяют, тест ниже перестанет быть про боевой путь.
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, StatisticsBffController.prototype.export),
    ).toEqual({ subject: 'statistics', action: 'export' });
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, StatisticsBffController.prototype.statistics),
    ).toEqual({ subject: 'statistics', action: 'read' });
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, StatisticsBffController.prototype.dashboard),
    ).toEqual({ subject: 'statistics', action: 'read' });
  });

  it('правило statistics:read сужает и выгрузку — предикат тот же, что на экране', () => {
    const onScreen = compileAccessPredicate({
      rules: [READ_RULE],
      subject: 'statistics',
      action: 'read',
      ctx: CTX,
    });
    const onExport = compileAccessPredicate({
      rules: [READ_RULE],
      subject: 'statistics',
      action: 'export',
      ctx: CTX,
    });
    expect(onExport).toBeDefined();
    expect(onExport).toEqual(onScreen);
    expect(mongoOf(onExport)).toEqual({ ownerId: { $eq: 'u1' } });
  });

  it('правило, написанное прямо на statistics:export, продолжает применяться', () => {
    expect(
      mongoOf(
        compileAccessPredicate({
          rules: [EXPORT_RULE],
          subject: 'statistics',
          action: 'export',
          ctx: CTX,
        }),
      ),
    ).toEqual({
      $or: [{ $nor: [{ confidential: { $eq: true } }] }, { ownerId: 'u1' }],
    });
  });

  it('read- и export-правила складываются через AND (сужение только усиливается)', () => {
    const mongo = mongoOf(
      compileAccessPredicate({
        rules: [READ_RULE, EXPORT_RULE],
        subject: 'statistics',
        action: 'export',
        ctx: CTX,
      }),
    ) as { $or?: unknown[] };
    expect(mongo.$or?.[0]).toEqual({
      $and: [{ ownerId: { $eq: 'u1' } }, { $nor: [{ confidential: { $eq: true } }] }],
    });
    expect(mongo.$or?.[1]).toEqual({ ownerId: 'u1' });
  });

  it('обратного переноса нет: export-правило не сужает экран (read)', () => {
    expect(
      compileAccessPredicate({
        rules: [EXPORT_RULE],
        subject: 'statistics',
        action: 'read',
        ctx: CTX,
      }),
    ).toBeUndefined();
  });

  it('расширение только для read-образных действий: write не подхватывает read-правила', () => {
    expect(
      compileAccessPredicate({
        rules: [{ ...READ_RULE, subject: 'deals' }],
        subject: 'deals',
        action: 'write',
        ctx: CTX,
      }),
    ).toBeUndefined();
  });

  it('на любом subject (reports:export — POST /reports/:id/export) действует то же правило', () => {
    expect(
      mongoOf(
        compileAccessPredicate({
          rules: [{ ...READ_RULE, subject: 'reports' }],
          subject: 'reports',
          action: 'export',
          ctx: CTX,
        }),
      ),
    ).toEqual({ ownerId: { $eq: 'u1' } });
  });
  /**
   * Возврат ревью (круг 1): заимствование read-правил не должно РАСШИРЯТЬ выгрузку.
   * До появления READ_SHAPED_ACTIONS export-маршрут компилировал только свои
   * правила; если теперь нескомпилируемое read-правило роняет весь предикат,
   * выгрузка становится шире, чем была. Наборы компилируются независимо.
   */
  describe('нескомпилируемое read-правило не роняет предикат export-маршрута', () => {
    const UNRESOLVABLE_READ_RULE: AbacPolicyRule = {
      effect: 'deny',
      subject: 'statistics',
      action: 'read',
      resource: '*',
      // user.departmentChain на gateway не резолвится → набор `read` не собирается.
      condition: {
        op: 'in',
        left: { ref: 'record.departmentId' },
        right: { ref: 'user.departmentChain' },
      },
    };
    const BROKEN_READ_RULE: AbacPolicyRule = {
      effect: 'allow',
      subject: 'statistics',
      action: 'read',
      resource: '*',
      condition: { op: 'bogus', left: { ref: 'record.ownerId' }, right: { lit: 1 } },
    };
    const OWN_EXPORT_RULE: AbacPolicyRule = {
      effect: 'allow',
      subject: 'statistics',
      action: 'export',
      resource: '*',
      condition: { op: 'eq', left: { ref: 'record.assigneeId' }, right: { ref: 'user.id' } },
    };

    it.each([
      ['нерезолвимый контекст', UNRESOLVABLE_READ_RULE],
      ['битое условие', BROKEN_READ_RULE],
    ])('%s в read-правиле: своё правило export по-прежнему сужает', (_name, badRead) => {
      expect(
        mongoOf(
          compileAccessPredicate({
            rules: [OWN_EXPORT_RULE, badRead],
            subject: 'statistics',
            action: 'export',
            ctx: CTX,
          }),
        ),
      ).toEqual({ assigneeId: { $eq: 'u1' } });
    });

    it('падает ВЕСЬ набор read, а не отдельное правило (частичного сужения не бывает)', () => {
      // READ_RULE компилируется, но лежит в одном наборе с нерезолвимым — набор
      // выкидывается целиком; остаётся только предикат собственного действия.
      expect(
        mongoOf(
          compileAccessPredicate({
            rules: [OWN_EXPORT_RULE, READ_RULE, UNRESOLVABLE_READ_RULE],
            subject: 'statistics',
            action: 'export',
            ctx: CTX,
          }),
        ),
      ).toEqual({ assigneeId: { $eq: 'u1' } });
    });

    it('своих правил нет → предиката нет (как на самом read-маршруте, не шире)', () => {
      expect(
        compileAccessPredicate({
          rules: [READ_RULE, UNRESOLVABLE_READ_RULE],
          subject: 'statistics',
          action: 'export',
          ctx: CTX,
        }),
      ).toBeUndefined();
      // Тот же набор на собственном маршруте read тоже даёт undefined — равнозначно.
      expect(
        compileAccessPredicate({
          rules: [READ_RULE, UNRESOLVABLE_READ_RULE],
          subject: 'statistics',
          action: 'read',
          ctx: CTX,
        }),
      ).toBeUndefined();
    });

    it('fail-safe своего действия сохранён: битое export-правило роняет предикат целиком', () => {
      expect(
        compileAccessPredicate({
          rules: [
            READ_RULE,
            {
              ...EXPORT_RULE,
              condition: { op: 'bogus', left: { ref: 'record.x' }, right: { lit: 1 } },
            },
          ],
          subject: 'statistics',
          action: 'export',
          ctx: CTX,
        }),
      ).toBeUndefined();
    });

    it('wildcard-правило (action "*") считается своим: его поломка роняет предикат', () => {
      expect(
        compileAccessPredicate({
          rules: [
            READ_RULE,
            {
              effect: 'allow',
              subject: 'statistics',
              action: '*',
              resource: '*',
              condition: {
                op: 'eq',
                left: { ref: 'record.dept' },
                right: { ref: 'user.departmentId' },
              },
            },
          ],
          subject: 'statistics',
          action: 'export',
          ctx: CTX,
        }),
      ).toBeUndefined();
    });

    it('wildcard-правило не дублируется в предикате export-маршрута', () => {
      const mongo = mongoOf(
        compileAccessPredicate({
          rules: [
            {
              effect: 'allow',
              subject: 'statistics',
              action: '*',
              resource: '*',
              condition: { op: 'lt', left: { ref: 'record.amount' }, right: { lit: 10 } },
            },
          ],
          subject: 'statistics',
          action: 'export',
          ctx: CTX,
        }),
      );
      expect(mongo).toEqual({ amount: { $lt: 10 } });
    });
  });
});
