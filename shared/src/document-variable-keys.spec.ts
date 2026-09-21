import { findUnknownDocumentVariableKeys } from './document-variable-keys';

describe('findUnknownDocumentVariableKeys (FR-DOCS-080)', () => {
  it('accepts catalog keys and globals for the deal context', () => {
    expect(
      findUnknownDocumentVariableKeys('deal', [
        'deal.amount',
        'contact.name',
        'project.name',
        'today.iso',
      ]),
    ).toEqual([]);
  });

  it('flags keys outside the context catalog', () => {
    expect(findUnknownDocumentVariableKeys('deal', ['company.inn', 'widget.x'])).toEqual([
      'company.inn',
      'widget.x',
    ]);
  });

  it('accepts dynamic order.field.* only in the order context', () => {
    expect(findUnknownDocumentVariableKeys('order', ['order.field.total'])).toEqual([]);
    expect(findUnknownDocumentVariableKeys('deal', ['order.field.total'])).toEqual([
      'order.field.total',
    ]);
    // Bare prefix without a field key stays unknown (fail-closed).
    expect(findUnknownDocumentVariableKeys('order', ['order.field.'])).toEqual(['order.field.']);
  });

  it('rejects variables from disabled donor modules when enabledModules is provided', () => {
    expect(
      findUnknownDocumentVariableKeys(
        'deal',
        ['deal.amount', 'contact.name', 'company.name'],
        ['deals'],
      ),
    ).toEqual(['contact.name', 'company.name']);
    expect(
      findUnknownDocumentVariableKeys(
        'deal',
        ['deal.amount', 'contact.name'],
        ['deals', 'contacts'],
      ),
    ).toEqual([]);
  });
});
