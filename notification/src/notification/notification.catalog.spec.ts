import { catalogForEdition, filterCatalogByModules, isMandatory, isBoxEdition } from './notification.catalog';

describe('notification.catalog edition filter', () => {
  const edition = process.env.FAIRFLOW_EDITION;

  afterAll(() => {
    if (edition === undefined) delete process.env.FAIRFLOW_EDITION;
    else process.env.FAIRFLOW_EDITION = edition;
  });

  it('drops billing category in BOX edition', () => {
    process.env.FAIRFLOW_EDITION = 'box';
    const cats = catalogForEdition();
    expect(cats.some((c) => c.category === 'billing')).toBe(false);
    expect(isMandatory('billing')).toBe(false);
  });

  it('keeps billing in cloud edition', () => {
    process.env.FAIRFLOW_EDITION = 'cloud';
    const cats = catalogForEdition();
    expect(cats.some((c) => c.category === 'billing')).toBe(true);
    expect(isMandatory('billing')).toBe(true);
  });

  it('defaults to box edition', () => {
    delete process.env.FAIRFLOW_EDITION;
    expect(isBoxEdition()).toBe(true);
  });

  it('filterCatalogByModules hides categories from disabled modules (FR-PROFILE-240)', () => {
    process.env.FAIRFLOW_EDITION = 'box';
    const base = catalogForEdition();
    const filtered = filterCatalogByModules(base, ['deals', 'activities']);
    expect(filtered.some((c) => c.category === 'deals')).toBe(true);
    expect(filtered.some((c) => c.category === 'activities')).toBe(true);
    expect(filtered.some((c) => c.category === 'sales')).toBe(false);
    expect(filtered.some((c) => c.module === 'orders')).toBe(false);
    // Platform/system categories (module=control) stay visible — control is not
    // a project module and is never listed in effectiveModules.
    expect(filtered.some((c) => c.category === 'org')).toBe(true);
    expect(filtered.some((c) => c.category === 'data')).toBe(true);
    expect(filtered.some((c) => c.category === 'import')).toBe(true);
  });
});
