/**
 * FR-CONTACTS-360: домен обязан читать карту колонок мастера импорта и НЕ доверять
 * ей слепо (карта из файла не может назначать владельца/подразделение).
 */
import {
  applyImportMapping,
  IMPORTABLE_CONTACT_FIELDS,
  mappingFromHeader,
  parseImportMapping,
  resolveImportMapping,
} from './import-mapping';

describe('карта колонок импорта контактов', () => {
  it('allowlist — зеркало шлюзового и списка полей в мастере импорта', () => {
    // Разъезд наборов = поле-приманка: мастер даёт его замапить, шлюз пропускает,
    // а домен роняет весь файл в 400 (так было с `companyName`). Здесь список
    // зафиксирован намеренно (изменение поля импорта — осознанное решение), а
    // совпадение с allowlist шлюза проверяет `crm-bff.contacts-import.spec.ts`:
    // он читает ЭТОТ файл, поэтому одностороннюю правку поймает.
    expect([...IMPORTABLE_CONTACT_FIELDS].sort()).toEqual(
      [
        'email',
        'firstName',
        'lastName',
        'middleName',
        'notes',
        'phone',
        'position',
        'source',
        'tags',
      ].sort(),
    );
  });

  it('явная карта «индекс → поле» читается', () => {
    expect(parseImportMapping('{"0":"lastName","1":"firstName","2":"email"}')).toEqual({
      0: 'lastName',
      1: 'firstName',
      2: 'email',
    });
  });

  it('попытка замапить ownerId из файла — отказ, а не тихое отбрасывание', () => {
    expect(() => parseImportMapping('{"0":"ownerId"}')).toThrow();
    expect(() => parseImportMapping('{"0":"departmentId"}')).toThrow();
    try {
      parseImportMapping('{"0":"createdBy"}');
    } catch (e) {
      expect(e).toMatchObject({ errorCode: 'invalid', details: { field: 'mappingJson' } });
    }
  });

  it('битый JSON карты — понятная доменная ошибка', () => {
    expect(() => parseImportMapping('{не json')).toThrow();
  });

  it('пустая карта = карты нет', () => {
    expect(parseImportMapping('')).toBeNull();
    expect(parseImportMapping('   ')).toBeNull();
    expect(parseImportMapping('{}')).toBeNull();
  });

  it('карта по заголовку файла (ru/en, регистр не важен)', () => {
    expect(mappingFromHeader(['Фамилия', 'Имя', 'Телефон', 'E-mail'])).toEqual({
      0: 'lastName',
      1: 'firstName',
      2: 'phone',
      3: 'email',
    });
    expect(mappingFromHeader(['LastName', 'FirstName'])).toEqual({
      0: 'lastName',
      1: 'firstName',
    });
  });

  it('приоритет: явная карта > заголовок > позиционный фолбэк', () => {
    const header = ['Фамилия', 'Имя'];
    expect(resolveImportMapping('{"0":"email"}', header)).toEqual({ 0: 'email' });
    expect(resolveImportMapping('', header)).toEqual({ 0: 'lastName', 1: 'firstName' });
    expect(resolveImportMapping('', ['коl1', 'кол2'])).toEqual({
      0: 'firstName',
      1: 'lastName',
      2: 'phone',
      3: 'email',
    });
  });

  it('строка раскладывается по полям, теги режутся по разделителям', () => {
    const mapping = { 0: 'lastName', 1: 'firstName', 2: 'tags', 3: 'notes' };
    expect(
      applyImportMapping(mapping, ['Иванов', 'Иван', 'vip; клиент,москва', ' важно ']),
    ).toEqual({
      firstName: 'Иван',
      lastName: 'Иванов',
      middleName: '',
      phone: '',
      email: '',
      position: '',
      source: '',
      notes: 'важно',
      tags: ['vip', 'клиент', 'москва'],
    });
  });

  it('пустые ячейки не создают пустых тегов и не затирают поля', () => {
    const mapping = { 0: 'firstName', 1: 'tags' };
    const res = applyImportMapping(mapping, ['Иван', ' ; ; ']);
    expect(res.firstName).toBe('Иван');
    expect(res.tags).toBeUndefined();
  });
});
