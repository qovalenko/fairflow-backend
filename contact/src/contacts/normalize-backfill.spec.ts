/**
 * Миграция дедуп-ключей: правила пересчёта и политика коллизий.
 *
 * Проверяется то, что нельзя проверить глазами на проде: пара «старый формат
 * против нового» действительно схлопывается в один ключ, коллизия разводится
 * детерминированно (уникальный индекс физически не пустит две записи с одним
 * ключом), а повторный запуск ничего не переигрывает.
 */
import { planNormalizedKeyBackfill, type BackfillDoc } from './normalize-backfill';

const P = 'prj-1';

function doc(over: Partial<BackfillDoc> & { id: string }): BackfillDoc {
  return { projectId: P, createdAt: new Date('2026-01-01T00:00:00Z'), ...over };
}

/** Применить план к набору документов — эмуляция bulkWrite для проверки идемпотентности. */
function apply(docs: BackfillDoc[], plan: ReturnType<typeof planNormalizedKeyBackfill>) {
  const byId = new Map(docs.map((d) => [d.id, { ...d }]));
  for (const p of plan.patches) {
    const d = byId.get(p.id);
    if (!d) throw new Error(`патч на неизвестный документ ${p.id}`);
    Object.assign(d, p.set);
    for (const f of p.unset) delete d[f];
  }
  return [...byId.values()];
}

describe('planNormalizedKeyBackfill', () => {
  it('пересчитывает записанный в старом формате телефон в E.164', () => {
    const docs = [doc({ id: 'a', phone: '8 (912) 345-67-89', phoneNormalized: '89123456789' })];
    const plan = planNormalizedKeyBackfill(docs);
    expect(plan.patches).toEqual([
      { id: 'a', set: { phoneNormalized: '+79123456789' }, unset: [] },
    ]);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('проставляет ключи там, где их вообще не было (легаси-сид)', () => {
    const docs = [doc({ id: 'a', phone: '+7 999 111-22-33', email: ' Ivan@Example.COM ' })];
    const plan = planNormalizedKeyBackfill(docs);
    expect(plan.patches[0].set).toEqual({
      phoneNormalized: '+79991112233',
      emailNormalized: 'ivan@example.com',
    });
  });

  it('снимает ключ, если исходное значение пустое (иначе занимает слот уникального индекса)', () => {
    const docs = [doc({ id: 'a', phone: '', phoneNormalized: '89123456789', email: 'a@b.c' })];
    const plan = planNormalizedKeyBackfill(docs);
    expect(plan.patches[0].unset).toEqual(['phoneNormalized']);
  });

  it('не трогает записи, у которых ключи уже верные', () => {
    const docs = [
      doc({
        id: 'a',
        phone: '+79123456789',
        phoneNormalized: '+79123456789',
        email: 'a@b.c',
        emailNormalized: 'a@b.c',
      }),
    ];
    expect(planNormalizedKeyBackfill(docs).patches).toHaveLength(0);
  });

  describe('коллизия «старая запись против новой»', () => {
    // Ровно тот случай, ради которого миграция и нужна: 8912… и +7912… — это один
    // и тот же номер, но до пересчёта у них разные ключи и уникальный индекс молчит.
    const docs = () => [
      doc({
        id: 'old',
        phone: '8 912 345-67-89',
        phoneNormalized: '89123456789',
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      doc({
        id: 'new',
        phone: '+7 912 345-67-89',
        phoneNormalized: '+79123456789',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ];

    it('оставляет ключ одной записи и снимает у второй — иначе индекс не встанет', () => {
      const plan = planNormalizedKeyBackfill(docs());
      // Победитель — у кого ключ уже в новом формате: минимум записи, максимум стабильности.
      expect(plan.patches).toEqual([{ id: 'old', set: {}, unset: ['phoneNormalized'] }]);
      expect(plan.conflicts).toEqual([
        {
          projectId: P,
          field: 'phoneNormalized',
          key: '+79123456789',
          keptId: 'new',
          droppedIds: ['old'],
        },
      ]);
    });

    it('после применения плана живой дубль по ключу ровно один — уникальный индекс встанет', () => {
      const after = apply(docs(), planNormalizedKeyBackfill(docs()));
      const withKey = after.filter((d) => d.phoneNormalized === '+79123456789');
      expect(withKey.map((d) => d.id)).toEqual(['new']);
    });

    it('повторный запуск не переигрывает решение (идемпотентность)', () => {
      const after = apply(docs(), planNormalizedKeyBackfill(docs()));
      const second = planNormalizedKeyBackfill(after);
      expect(second.patches).toHaveLength(0);
      // Конфликт остаётся видимым в отчёте: пару всё ещё должен развести человек.
      expect(second.conflicts).toHaveLength(1);
      expect(second.conflicts[0].keptId).toBe('new');
    });
  });

  it('в коллизии без «уже верного» ключа побеждает самая ранняя запись, затем _id', () => {
    const docs = [
      doc({ id: 'b', phone: '89123456789', createdAt: new Date('2025-06-01T00:00:00Z') }),
      doc({ id: 'a', phone: '79123456789', createdAt: new Date('2025-01-01T00:00:00Z') }),
      doc({ id: 'c', phone: '9123456789', createdAt: new Date('2025-01-01T00:00:00Z') }),
    ];
    const plan = planNormalizedKeyBackfill(docs);
    expect(plan.conflicts[0].keptId).toBe('a');
    expect(plan.conflicts[0].droppedIds.sort()).toEqual(['b', 'c']);
    expect(plan.patches.find((p) => p.id === 'a')!.set).toEqual({
      phoneNormalized: '+79123456789',
    });
  });

  it('две живые записи с ОДИНАКОВЫМ уже верным ключом тоже разводятся (иначе createIndex падает)', () => {
    // Так выглядят данные, на которых уникальный индекс вообще не встал: он
    // best-effort, при ошибке сервис лишь пишет warn и стартует без него.
    const docs = [
      doc({
        id: 'b',
        phone: '+79123456789',
        phoneNormalized: '+79123456789',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
      doc({
        id: 'a',
        phone: '+7 912 345-67-89',
        phoneNormalized: '+79123456789',
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
    ];
    const plan = planNormalizedKeyBackfill(docs);
    expect(plan.conflicts[0]).toMatchObject({ keptId: 'a', droppedIds: ['b'] });
    expect(plan.patches).toEqual([{ id: 'b', set: {}, unset: ['phoneNormalized'] }]);
    expect(apply(docs, plan).filter((d) => d.phoneNormalized)).toHaveLength(1);
  });

  it('коллизии считаются в границах проекта — одинаковый номер в разных проектах не конфликт', () => {
    const docs = [
      doc({ id: 'a', phone: '89123456789' }),
      { ...doc({ id: 'b', phone: '+79123456789' }), projectId: 'prj-2' },
    ];
    const plan = planNormalizedKeyBackfill(docs);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.patches).toHaveLength(2);
  });

  it('коллизии по e-mail разводятся так же (регистр/пробелы)', () => {
    const docs = [
      doc({
        id: 'a',
        email: 'Ivan@Example.com',
        emailNormalized: 'ivan@example.com',
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      doc({ id: 'b', email: ' IVAN@example.com ', createdAt: new Date('2026-01-01T00:00:00Z') }),
    ];
    const plan = planNormalizedKeyBackfill(docs);
    expect(plan.conflicts[0]).toMatchObject({
      field: 'emailNormalized',
      key: 'ivan@example.com',
      keptId: 'a',
      droppedIds: ['b'],
    });
    // У 'b' ключа не было — снимать нечего, лишнего патча быть не должно.
    expect(plan.patches.find((p) => p.id === 'b')).toBeUndefined();
  });

  it('телефон и e-mail разводятся независимо: конфликт по телефону не снимает e-mail', () => {
    const docs = [
      doc({
        id: 'a',
        phone: '89123456789',
        email: 'a@b.c',
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      doc({
        id: 'b',
        phone: '+79123456789',
        email: 'x@y.z',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ];
    const plan = planNormalizedKeyBackfill(docs);
    const b = plan.patches.find((p) => p.id === 'b')!;
    expect(b.set.emailNormalized).toBe('x@y.z');
    expect(b.unset).not.toContain('emailNormalized');
  });
});
