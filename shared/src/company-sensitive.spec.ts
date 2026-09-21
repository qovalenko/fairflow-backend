import {
  companySensitiveReveal,
  maskCompanySensitiveFields,
  COMPANY_SENSITIVE_REST_FIELDS,
} from './company-sensitive';
import { buildAbacGateSnapshot } from './abac/materialize';
import { evalGateRaw } from './abac';

describe('company-sensitive projection (FR-COMPANIES-380)', () => {
  it('masks inn/kpp/bank* when reveal=false', () => {
    const row = {
      id: 'c1',
      name: 'Акме',
      inn: '7701234567',
      kpp: '770101001',
      bankName: 'Сбер',
      bik: '044525225',
    };
    const masked = maskCompanySensitiveFields(row, false);
    expect(masked.inn).toBe('***');
    expect(masked.kpp).toBe('***');
    expect(masked.bankName).toBe('***');
    expect(masked.bik).toBe('***');
    expect(masked.name).toBe('Акме');
  });

  it('companySensitiveReveal is true without access predicate', () => {
    expect(companySensitiveReveal(undefined, { region: 'EU' })).toBe(true);
  });

  it('companySensitiveReveal fails closed on malformed predicate', () => {
    expect(companySensitiveReveal({ present: true, malformed: true }, {})).toBe(false);
  });

  it('COMPANY_SENSITIVE_REST_FIELDS includes bank block', () => {
    expect(COMPANY_SENSITIVE_REST_FIELDS).toEqual(
      expect.arrayContaining(['bankName', 'bik', 'correspondentAccount', 'settlementAccount']),
    );
  });

  it('evalGate path: restrictive region rule hides sensitive fields', () => {
    const ir = {
      op: 'in',
      left: { ref: 'record.region' },
      right: { lit: ['RU'] },
    };
    const reveal = companySensitiveReveal(
      { present: true, ir: ir as never },
      { region: 'EU', industry: 'IT' },
    );
    expect(reveal).toBe(false);
    const ok = companySensitiveReveal(
      { present: true, ir: ir as never },
      { region: 'RU', industry: 'IT' },
    );
    expect(ok).toBe(true);
    expect(buildAbacGateSnapshot('companies', { region: 'RU' })).toEqual({ region: 'RU' });
    expect(evalGateRaw(ir as never, { region: 'RU' })).toBe(true);
  });
});
