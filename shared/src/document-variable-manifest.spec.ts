import {
  aggregateDocumentVariableManifest,
  DOCUMENT_VARIABLE_MANIFESTS,
} from './document-variable-manifest';

describe('document-variable-manifest (FR-DOCS-310)', () => {
  it('exposes donor manifests per context', () => {
    expect(DOCUMENT_VARIABLE_MANIFESTS.order.some((v) => v.key === 'order.number')).toBe(true);
    expect(DOCUMENT_VARIABLE_MANIFESTS.deal.some((v) => v.key === 'deal.name')).toBe(true);
  });

  it('filters variables by enabled modules', () => {
    const all = aggregateDocumentVariableManifest('order');
    const gated = aggregateDocumentVariableManifest('order', ['orders']);
    expect(gated.some((v) => v.key === 'deal.name')).toBe(false);
    expect(all.length).toBeGreaterThan(gated.length);
  });

  it('always appends globals', () => {
    const items = aggregateDocumentVariableManifest('contact', []);
    expect(items.some((v) => v.key === 'today')).toBe(true);
  });
});
