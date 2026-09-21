import { computeOrderDrift, entityDrifted, type SourceRead } from './order-drift';

const contactSnap = { name: 'Иван Петров', phone: '+7900', email: 'i@a.ru' };
const companySnap = { name: 'ООО Альфа', inn: '7701234567', kpp: '770101001' };

const present = (fields: Record<string, string>): SourceRead => ({ state: 'present', fields });
const deleted = (): SourceRead => ({ state: 'deleted', fields: {} });
const unknown = (): SourceRead => ({ state: 'unknown', fields: {} });

describe('computeOrderDrift', () => {
  it('no drift when snapshot matches current source values', () => {
    const r = computeOrderDrift({
      contactId: 'c1',
      companyId: 'co1',
      snapshot: { contact: contactSnap, company: companySnap },
      contactRead: present({ name: 'Иван Петров', phone: '+7900', email: 'i@a.ru' }),
      companyRead: present({ name: 'ООО Альфа', inn: '7701234567', kpp: '770101001' }),
    });
    expect(r).toEqual({ has_drift: false, source_state: 'present', diffs: [] });
  });

  it('reports per-field drift for a changed company INN', () => {
    const r = computeOrderDrift({
      contactId: 'c1',
      companyId: 'co1',
      snapshot: { contact: contactSnap, company: companySnap },
      contactRead: present({ name: 'Иван Петров', phone: '+7900', email: 'i@a.ru' }),
      companyRead: present({ name: 'ООО Альфа', inn: '7707654321', kpp: '770101001' }),
    });
    expect(r.has_drift).toBe(true);
    expect(r.source_state).toBe('present');
    expect(r.diffs).toEqual([
      { entity: 'company', field: 'inn', old: '7701234567', new: '7707654321' },
    ]);
  });

  it('reports multiple diffs across contact and company', () => {
    const r = computeOrderDrift({
      contactId: 'c1',
      companyId: 'co1',
      snapshot: { contact: contactSnap, company: companySnap },
      contactRead: present({ name: 'Иван Сидоров', phone: '+7900', email: 'new@a.ru' }),
      companyRead: present({ name: 'ООО Бета', inn: '7701234567', kpp: '770101001' }),
    });
    expect(r.has_drift).toBe(true);
    expect(r.diffs).toEqual([
      { entity: 'contact', field: 'name', old: 'Иван Петров', new: 'Иван Сидоров' },
      { entity: 'contact', field: 'email', old: 'i@a.ru', new: 'new@a.ru' },
      { entity: 'company', field: 'name', old: 'ООО Альфа', new: 'ООО Бета' },
    ]);
  });

  it('treats whitespace-only differences as equal (normalised compare)', () => {
    const r = computeOrderDrift({
      contactId: 'c1',
      snapshot: { contact: { name: 'Иван Петров', phone: '', email: '' } },
      contactRead: present({ name: '  Иван Петров  ', phone: '', email: '' }),
    });
    expect(r.has_drift).toBe(false);
  });

  it('source_state=deleted with has_drift=true when donor answers NOT_FOUND', () => {
    const r = computeOrderDrift({
      contactId: 'c1',
      companyId: 'co1',
      snapshot: { contact: contactSnap, company: companySnap },
      contactRead: present({ name: 'Иван Петров', phone: '+7900', email: 'i@a.ru' }),
      companyRead: deleted(),
    });
    expect(r.has_drift).toBe(true);
    expect(r.source_state).toBe('deleted');
    // deleted company → each non-empty snapshot field becomes a drift to ''.
    expect(r.diffs).toEqual([
      { entity: 'company', field: 'name', old: 'ООО Альфа', new: '' },
      { entity: 'company', field: 'inn', old: '7701234567', new: '' },
      { entity: 'company', field: 'kpp', old: '770101001', new: '' },
    ]);
  });

  it('source_state=unknown with has_drift=false and no diffs when donor unavailable (do not lie)', () => {
    const r = computeOrderDrift({
      contactId: 'c1',
      companyId: 'co1',
      snapshot: { contact: contactSnap, company: companySnap },
      contactRead: present({ name: 'CHANGED', phone: '+7900', email: 'i@a.ru' }),
      companyRead: unknown(),
    });
    // unknown takes precedence — a real contact change is suppressed rather than
    // shown as an unresolvable banner.
    expect(r).toEqual({ has_drift: false, source_state: 'unknown', diffs: [] });
  });

  it('unknown wins over deleted (still cannot reliably report)', () => {
    const r = computeOrderDrift({
      contactId: 'c1',
      companyId: 'co1',
      snapshot: { contact: contactSnap, company: companySnap },
      contactRead: deleted(),
      companyRead: unknown(),
    });
    expect(r).toEqual({ has_drift: false, source_state: 'unknown', diffs: [] });
  });

  it('ignores entities the order does not link', () => {
    const r = computeOrderDrift({
      companyId: 'co1',
      // no contactId → contactRead is not evaluated even if present
      snapshot: { contact: contactSnap, company: companySnap },
      contactRead: unknown(),
      companyRead: present({ name: 'ООО Альфа', inn: '7701234567', kpp: '770101001' }),
    });
    expect(r).toEqual({ has_drift: false, source_state: 'present', diffs: [] });
  });

  it('no linked entities → no drift, present', () => {
    const r = computeOrderDrift({ snapshot: null });
    expect(r).toEqual({ has_drift: false, source_state: 'present', diffs: [] });
  });

  it('empty snapshot vs populated source → every field drifts (baseline capture needed)', () => {
    const r = computeOrderDrift({
      contactId: 'c1',
      snapshot: { contact: {} },
      contactRead: present({ name: 'Иван Петров', phone: '+7900', email: 'i@a.ru' }),
    });
    expect(r.has_drift).toBe(true);
    expect(r.source_state).toBe('present');
    expect(r.diffs).toEqual([
      { entity: 'contact', field: 'name', old: '', new: 'Иван Петров' },
      { entity: 'contact', field: 'phone', old: '', new: '+7900' },
      { entity: 'contact', field: 'email', old: '', new: 'i@a.ru' },
    ]);
  });
});

describe('entityDrifted (reactive per-entity check, FR-ORDERS-390)', () => {
  const snapshot = {
    contact: { name: 'Ann', phone: '+7', email: 'a@x' },
    company: { name: 'Acme', inn: '77', kpp: '01' },
  };

  it('is false when the read matches the snapshot', () => {
    expect(
      entityDrifted('contact', snapshot, {
        state: 'present',
        fields: { name: 'Ann', phone: '+7', email: 'a@x' },
      }),
    ).toBe(false);
  });

  it('is true when a compared requisite changed', () => {
    expect(
      entityDrifted('contact', snapshot, {
        state: 'present',
        fields: { name: 'Anna', phone: '+7', email: 'a@x' },
      }),
    ).toBe(true);
  });

  it('ignores fields outside the compared requisite set', () => {
    expect(
      entityDrifted('company', snapshot, {
        state: 'present',
        fields: { name: 'Acme', inn: '77', kpp: '01', address: 'moved' },
      }),
    ).toBe(false);
  });

  it('is true for a deleted source and false for an unreadable one', () => {
    expect(entityDrifted('company', snapshot, { state: 'deleted', fields: {} })).toBe(true);
    expect(entityDrifted('company', snapshot, { state: 'unknown', fields: {} })).toBe(false);
  });

  it('treats a missing snapshot side as empty (a filled source is drift)', () => {
    expect(entityDrifted('contact', null, { state: 'present', fields: { name: 'Ann' } })).toBe(
      true,
    );
  });
});
