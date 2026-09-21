import {
  companyIdsFromLinks,
  companyLinksFromProto,
  normalizeCompanyLinks,
  remapCompanyRefs,
} from './company-links';

describe('company-links (FR-CONTACTS-320)', () => {
  it('normalizes role/primary/period and syncs companyIds', () => {
    const links = normalizeCompanyLinks([
      {
        companyId: 'c1',
        role: 'CEO',
        isPrimary: true,
        period: { from: 1000, to: 2000 },
      },
      { companyId: 'c2', role: '  ' },
    ]);
    expect(links).toEqual([
      {
        companyId: 'c1',
        role: 'CEO',
        isPrimary: true,
        period: { from: 1000, to: 2000 },
      },
      { companyId: 'c2', isPrimary: false },
    ]);
    expect(companyIdsFromLinks(links)).toEqual(['c1', 'c2']);
  });

  it('falls back from legacy companyIds', () => {
    const links = normalizeCompanyLinks(undefined, ['a', 'b']);
    expect(links[0].isPrimary).toBe(true);
    expect(companyIdsFromLinks(links)).toEqual(['a', 'b']);
  });

  it('maps proto snake_case into CompanyLink', () => {
    const links = companyLinksFromProto([
      { company_id: 'c1', role: 'CEO', is_primary: true, period: { from: 1, to: 0 } },
    ]);
    expect(links[0]).toMatchObject({ companyId: 'c1', role: 'CEO', isPrimary: true });
  });

  it('remaps loser→master on company refs with dedupe (FR-COMPANIES-140)', () => {
    const res = remapCompanyRefs(
      'co-loser',
      'co-master',
      ['co-loser', 'co-other'],
      [{ companyId: 'co-loser', role: 'CEO' }],
      ['co-loser'],
    );
    expect(res.changed).toBe(true);
    expect(res.companyIds).toEqual(['co-master', 'co-other']);
    expect(res.companyLinks).toEqual([{ companyId: 'co-master', role: 'CEO' }]);
    expect(res.orphanedCompanyIds).toEqual([]);
  });
});
