/**
 * TODO-164: разбор CSV импорта контактов. Было `line.split(/[,;]/)` — режет
 * одновременно по запятой и по точке-с-запятой, кавычек не понимает.
 */
import { detectDelimiter, parseCsv } from './csv';

describe('CSV импорта контактов (TODO-164)', () => {
  it('регрессия: поле в кавычках с запятой внутри не сдвигает колонки', () => {
    const text = 'Имя;Фамилия;Телефон;Email\n"Иванов, Иван";Иванов;+79001234567;a@b.ru';
    const rows = parseCsv(text);
    expect(rows[1]).toEqual(['Иванов, Иван', 'Иванов', '+79001234567', 'a@b.ru']);
    // Старое поведение дало бы 5 колонок со сдвигом телефона и почты вправо.
    expect(rows[1]).toHaveLength(4);
  });

  it('автоопределение разделителя: запятая, точка с запятой, табуляция', () => {
    expect(detectDelimiter('a,b,c')).toBe(',');
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    // Запятые ВНУТРИ кавычек не голосуют за разделитель.
    expect(detectDelimiter('"Иванов, Иван";b;c')).toBe(';');
  });

  it('удвоенная кавычка — это одна кавычка внутри поля', () => {
    const rows = parseCsv('a,b\n"ООО ""Ромашка""",x');
    expect(rows[1]).toEqual(['ООО "Ромашка"', 'x']);
  });

  it('перевод строки внутри закавыченного поля не рвёт запись', () => {
    const rows = parseCsv('a,b\n"первая\nвторая",x');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['первая\nвторая', 'x']);
  });

  it('CRLF, BOM и хвостовой перевод строки не создают лишних строк', () => {
    const rows = parseCsv('﻿a,b\r\n1,2\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('незакавыченные значения обрезаются по краям, закавыченные — нет', () => {
    const rows = parseCsv('a,b\n  x  ," y "');
    expect(rows[1]).toEqual(['x', ' y ']);
  });

  it('пустой файл и файл только с заголовком дают пустой набор данных', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('Имя;Фамилия\n').slice(1)).toEqual([]);
  });
});
