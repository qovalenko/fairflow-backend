import { prefillFromStruct } from './prefill-struct';

describe('prefillFromStruct', () => {
  it('возвращает undefined для null и не-объекта', () => {
    expect(prefillFromStruct(null)).toBeUndefined();
    expect(prefillFromStruct(undefined)).toBeUndefined();
    expect(prefillFromStruct('x')).toBeUndefined();
  });

  it('читает плоские scalar-поля', () => {
    expect(prefillFromStruct({ a: 'x', b: 1, c: true })).toEqual({ a: 'x', b: 1, c: true });
  });

  it('распаковывает protobuf Struct через fields', () => {
    expect(
      prefillFromStruct({
        fields: {
          country: { stringValue: 'RU' },
          limit: { numberValue: 10 },
          enabled: { boolValue: true },
        },
      }),
    ).toEqual({ country: 'RU', limit: 10, enabled: true });
  });

  it('игнорирует вложенные объекты без string/number/boolValue', () => {
    expect(prefillFromStruct({ nested: { foo: 'bar' }, ok: 'yes' })).toEqual({ ok: 'yes' });
  });

  it('приоритет scalar над wrapper, если оба заданы', () => {
    expect(prefillFromStruct({ key: 'plain' })).toEqual({ key: 'plain' });
    expect(prefillFromStruct({ key: { stringValue: 'wrapped' } })).toEqual({ key: 'wrapped' });
  });
});
