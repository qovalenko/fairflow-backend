import {
  computeContactDrift,
  computeCompanyDrift,
  type NormalizedChange,
} from './drift-consumer.service';

/**
 * Unit tests for the pure snapshot ↔ event diff that powers drift detection
 * (FR-26/27). The RabbitMQ transport / Mongo persistence are integration
 * concerns; here we pin the field-mapping + reconstruction logic that decides
 * WHICH snapshot fields drifted and with what current value.
 */
describe('drift diff — computeContactDrift', () => {
  const snapshot = { name: 'Иван Петров', phone: '+79201234567', email: 'iv@mail.ru' };

  const ch = (
    field: string,
    newValue: unknown,
    extra?: Partial<NormalizedChange>,
  ): NormalizedChange => ({
    field,
    newValue,
    changedBy: 'u3',
    changedAt: 1719300000000,
    ...extra,
  });

  it('flags a phone change with snapshot + current values and attribution', () => {
    const drift = computeContactDrift(snapshot, [ch('phone', '+79990001122')]);
    expect(drift).toEqual([
      {
        field: 'phone',
        snapshotValue: '+79201234567',
        currentValue: '+79990001122',
        changedBy: 'u3',
        changedAt: 1719300000000,
      },
    ]);
  });

  it('flags an email change', () => {
    const drift = computeContactDrift(snapshot, [ch('email', 'new@mail.ru')]);
    expect(drift.map((d) => d.field)).toEqual(['email']);
    expect(drift[0].currentValue).toBe('new@mail.ru');
  });

  it('does NOT flag when the new value equals the snapshot (no drift)', () => {
    expect(computeContactDrift(snapshot, [ch('phone', '+79201234567')])).toEqual([]);
    expect(computeContactDrift(snapshot, [ch('email', 'iv@mail.ru')])).toEqual([]);
  });

  it('reconstructs the combined name when firstName changes (lastName kept from snapshot)', () => {
    const drift = computeContactDrift(snapshot, [ch('firstName', 'Пётр')]);
    expect(drift).toHaveLength(1);
    expect(drift[0].field).toBe('name');
    expect(drift[0].snapshotValue).toBe('Иван Петров');
    expect(drift[0].currentValue).toBe('Пётр Петров');
  });

  it('reconstructs the combined name when lastName changes (firstName kept)', () => {
    const drift = computeContactDrift(snapshot, [ch('lastName', 'Сидоров')]);
    expect(drift[0].currentValue).toBe('Иван Сидоров');
  });

  it('combines both firstName + lastName changes into the new name', () => {
    const drift = computeContactDrift(snapshot, [
      ch('firstName', 'Пётр'),
      ch('lastName', 'Сидоров', { changedAt: 1719400000000 }),
    ]);
    expect(drift.filter((d) => d.field === 'name')[0].currentValue).toBe('Пётр Сидоров');
    // Attribution goes to the later change.
    expect(drift.filter((d) => d.field === 'name')[0].changedAt).toBe(1719400000000);
  });

  it('does not flag name when firstName is re-set to the same value', () => {
    expect(computeContactDrift(snapshot, [ch('firstName', 'Иван')])).toEqual([]);
  });

  it('flags multiple fields at once (phone + name)', () => {
    const drift = computeContactDrift(snapshot, [
      ch('phone', '+79990001122'),
      ch('firstName', 'Пётр'),
    ]);
    expect(drift.map((d) => d.field).sort()).toEqual(['name', 'phone']);
  });

  it('treats null/undefined snapshot fields as empty strings', () => {
    const drift = computeContactDrift({ name: '', phone: '', email: '' }, [ch('phone', '+7999')]);
    expect(drift[0].snapshotValue).toBe('');
    expect(drift[0].currentValue).toBe('+7999');
  });
});

describe('drift diff — computeCompanyDrift', () => {
  const snapshot = { name: 'ООО Ромашка' };

  it('flags a company name change under the company. prefix', () => {
    const drift = computeCompanyDrift(snapshot, [
      { field: 'name', newValue: 'ООО Лютик', changedBy: 'u5', changedAt: 1719500000000 },
    ]);
    expect(drift).toEqual([
      {
        field: 'company.name',
        snapshotValue: 'ООО Ромашка',
        currentValue: 'ООО Лютик',
        changedBy: 'u5',
        changedAt: 1719500000000,
      },
    ]);
  });

  it('flags an inn change under the company.inn prefix', () => {
    const snap = { name: 'ООО Ромашка', inn: '7701234567' };
    expect(
      computeCompanyDrift(snap, [
        { field: 'inn', newValue: '7707654321', changedBy: 'u5', changedAt: 1719500000000 },
      ]),
    ).toEqual([
      {
        field: 'company.inn',
        snapshotValue: '7701234567',
        currentValue: '7707654321',
        changedBy: 'u5',
        changedAt: 1719500000000,
      },
    ]);
  });

  it('ignores non-tracked company changes when snapshot has only name', () => {
    expect(computeCompanyDrift(snapshot, [{ field: 'domain', newValue: 'foo.ru' }])).toEqual([]);
  });

  it('does not flag when the name is unchanged', () => {
    expect(computeCompanyDrift(snapshot, [{ field: 'name', newValue: 'ООО Ромашка' }])).toEqual([]);
  });
});
