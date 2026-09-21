import { buildSearchTokens } from './search-tokens';

describe('buildSearchTokens', () => {
  it('нормализует телефон и email для поискового индекса', () => {
    const tokens = buildSearchTokens(['Иван Петров', '+7 (912) 123-45-67', 'ivan@mail.ru']);
    expect(tokens).toContain('79121234567');
    expect(tokens).toContain('4567');
    expect(tokens).toContain('ivan@mail.ru');
  });
});
