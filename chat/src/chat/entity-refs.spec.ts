import { extractEntityRefsFromText } from './entity-refs';

describe('extractEntityRefsFromText', () => {
  it('parses inline entity tokens (FR-CHAT-440)', () => {
    const refs = extractEntityRefsFromText(
      'см. [[entity:deal:d1|Сделка А]] и [[entity:contact:c1|Иван]]',
    );
    expect(refs).toEqual([
      { type: 'deal', id: 'd1', label: 'Сделка А' },
      { type: 'contact', id: 'c1', label: 'Иван' },
    ]);
  });

  it('dedupes repeated tokens', () => {
    const text = '[[entity:order:o1|Продажа]] [[entity:order:o1|Продажа]]';
    expect(extractEntityRefsFromText(text)).toEqual([{ type: 'order', id: 'o1', label: 'Продажа' }]);
  });

  it('игнорирует неизвестный тип entity', () => {
    expect(extractEntityRefsFromText('[[entity:unknown:x1|X]]')).toEqual([]);
  });

  it('подставляет type как label при пустой подписи', () => {
    expect(extractEntityRefsFromText('[[entity:company:c1|]]')).toEqual([
      { type: 'company', id: 'c1', label: 'company' },
    ]);
  });

  it('обрабатывает null/undefined text как пустую строку', () => {
    expect(extractEntityRefsFromText(null as unknown as string)).toEqual([]);
  });
});
