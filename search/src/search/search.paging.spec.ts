/**
 * TODO-261 — постраничность страницы результатов.
 *
 * AS-IS (дефект): группы строились как `.find(matchFilter).sort({updatedAt:-1})
 * .limit(max(perTypeLimit*4, perTypeLimit))` БЕЗ `skip`, то есть `page_index` в
 * их построении не участвовал вообще. Единственный путь, где он применялся —
 * плоский legacy-`list`, который BFF сознательно выбрасывает из ответа. Итог:
 * любая страница результатов показывала одни и те же первые N хитов, а кнопка
 * «Вперёд» на фронте была активна, пока `(page+1)*pageSize < total`.
 *
 * TO-BE: срез страницы режется в БД из глобально упорядоченной
 * (score, updatedAt, _id) последовательности — страницы не пересекаются и в
 * сумме покрывают весь видимый набор; «есть ли следующая» отдаёт домен
 * (`has_more`), потому что размер страницы на тип (`per_type_limit`) резолвит
 * gateway из настроек проекта, а не клиент.
 */
import { SearchService } from './search.service';
import { buildMongo, row } from './fake-mongo.testkit';
import type { VisibilityScope } from '@fairflow/shared';

const PID = 'proj-1';
const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

/** N готовых документов индекса одного типа, все матчатся запросом `иван`. */
function indexRows(entityType: string, n: number, prefix = 'c') {
  return Array.from({ length: n }, (_, i) =>
    row(`${prefix}${i}`, {
      projectId: PID,
      entityType,
      entityId: `${prefix}${i}`,
      // Одинаковый title → у всех одинаковый score, порядок задаёт updatedAt,
      // а при равенстве — _id: ровно тот случай, где страницы могли «плыть».
      title: `Иван Петров ${i}`,
      subtitle: '',
      path: `/p/${PID}/contacts/${prefix}${i}`,
      tokens: `иван петров ${i}`,
      ownerId: 'user-1',
      departmentId: null,
      deletedAt: null,
      updatedAt: 1_000 + i,
    }),
  );
}

const ctx = { ctx: { scope: ALL_SCOPE } } as const;

describe('search(): постраничность групп (TODO-261)', () => {
  it('страница 2 отдаёт ДРУГИЕ записи, чем страница 1, и не пересекается с ней', async () => {
    const { mongo } = buildMongo({ index: indexRows('contact', 25) });
    const svc = new SearchService(mongo as never);

    const p0 = await svc.search(PID, 'иван', 0, 25, {
      entityTypes: ['contact'],
      perTypeLimit: 10,
      ...ctx,
    });
    const p1 = await svc.search(PID, 'иван', 1, 25, {
      entityTypes: ['contact'],
      perTypeLimit: 10,
      ...ctx,
    });

    const ids0 = p0.groups[0].list.map((h) => h.entity_id);
    const ids1 = p1.groups[0].list.map((h) => h.entity_id);
    expect(ids0).toHaveLength(10);
    expect(ids1).toHaveLength(10);
    expect(ids1).not.toEqual(ids0);
    expect(ids0.filter((id) => ids1.includes(id))).toEqual([]);
    // type_total остаётся полным счётчиком из агрегации, а не длиной страницы.
    expect(p0.groups[0].type_total).toBe(25);
    expect(p1.groups[0].type_total).toBe(25);
  });

  it('страницы в сумме покрывают весь видимый набор без дублей и пропусков', async () => {
    const { mongo } = buildMongo({ index: indexRows('contact', 25) });
    const svc = new SearchService(mongo as never);

    const seen: string[] = [];
    for (const page of [0, 1, 2]) {
      const r = await svc.search(PID, 'иван', page, 25, {
        entityTypes: ['contact'],
        perTypeLimit: 10,
        ...ctx,
      });
      seen.push(...(r.groups[0]?.list ?? []).map((h) => h.entity_id));
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('за последней страницей группа не отдаётся (пустая секция не рисуется)', async () => {
    const { mongo } = buildMongo({ index: indexRows('contact', 12) });
    const svc = new SearchService(mongo as never);

    const beyond = await svc.search(PID, 'иван', 3, 25, {
      entityTypes: ['contact'],
      perTypeLimit: 10,
      ...ctx,
    });
    expect(beyond.groups).toEqual([]);
    // Счётчики видимого набора при этом остаются честными.
    expect(beyond.total).toBe(12);
    expect(beyond.total_by_type).toEqual({ contact: 12 });
    expect(beyond.has_more).toBe(false);
  });

  it('has_more считает домен по per-type тоталам и ЭФФЕКТИВНОМУ размеру страницы', async () => {
    const { mongo } = buildMongo({ index: indexRows('contact', 12) });
    const svc = new SearchService(mongo as never);

    const p0 = await svc.search(PID, 'иван', 0, 25, {
      entityTypes: ['contact'],
      perTypeLimit: 10,
      ...ctx,
    });
    expect(p0.has_more).toBe(true);

    const p1 = await svc.search(PID, 'иван', 1, 25, {
      entityTypes: ['contact'],
      perTypeLimit: 10,
      ...ctx,
    });
    expect(p1.groups[0].list).toHaveLength(2);
    // 12 записей, по 10 на страницу → после второй страницы следующей нет,
    // хотя наивное `(page+1)*pageSize < total` тоже дало бы false только
    // случайно: размер страницы здесь perTypeLimit=10, а не pageSize=25.
    expect(p1.has_more).toBe(false);
  });

  it('overlay (page 0) не меняет поведения: те же N лучших по релевантности', async () => {
    const { mongo } = buildMongo({
      index: [
        // Точное совпадение title, но самая старая запись: при «4× свежих
        // кандидатов» она попадала в топ, и это надо сохранить.
        row('exact', {
          projectId: PID,
          entityType: 'contact',
          entityId: 'exact',
          title: 'иван',
          subtitle: '',
          path: '',
          tokens: 'иван',
          ownerId: 'user-1',
          departmentId: null,
          deletedAt: null,
          updatedAt: 1,
        }),
        ...indexRows('contact', 5, 'n'),
      ],
    });
    const svc = new SearchService(mongo as never);

    const r = await svc.search(PID, 'иван', 0, 25, {
      entityTypes: ['contact'],
      perTypeLimit: 3,
      ...ctx,
    });
    expect(r.groups[0].list[0].entity_id).toBe('exact');
    expect(r.groups[0].list[0].score).toBe(120 + 80 + 50 + 10);
    expect(r.groups[0].list).toHaveLength(3);
  });

  it('несколько типов: каждая группа режется своей страницей, has_more по любому из типов', async () => {
    const { mongo } = buildMongo({
      index: [...indexRows('contact', 12, 'c'), ...indexRows('company', 3, 'k')],
    });
    const svc = new SearchService(mongo as never);

    const p1 = await svc.search(PID, 'иван', 1, 25, {
      entityTypes: ['contact', 'company'],
      perTypeLimit: 10,
      ...ctx,
    });
    // company исчерпалась на первой странице → второй секции для неё нет.
    expect(p1.groups.map((g) => g.entity_type)).toEqual(['contact']);
    expect(p1.total_by_type).toEqual({ contact: 12, company: 3 });
    expect(p1.has_more).toBe(false);
  });

  it('отрицательный/NaN page_index не уходит в $skip как есть', async () => {
    const { mongo } = buildMongo({ index: indexRows('contact', 3) });
    const svc = new SearchService(mongo as never);

    for (const bad of [-1, Number.NaN]) {
      const r = await svc.search(PID, 'иван', bad, 25, {
        entityTypes: ['contact'],
        perTypeLimit: 10,
        ...ctx,
      });
      expect(r.groups[0].list).toHaveLength(3);
    }
  });

  it('legacy плоский list не пагинируется повторно поверх уже нарезанных групп', async () => {
    const { mongo } = buildMongo({ index: indexRows('contact', 25) });
    const svc = new SearchService(mongo as never);

    const p1 = await svc.search(PID, 'иван', 1, 25, {
      entityTypes: ['contact'],
      perTypeLimit: 10,
      ...ctx,
    });
    expect(p1.list.map((h) => h.entity_id)).toEqual(
      p1.groups[0].list.map((h) => h.entity_id),
    );
  });
});
