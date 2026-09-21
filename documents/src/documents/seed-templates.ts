import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

/**
 * Стартовые шаблоны для нового box-проекта (BX-DOCS-5 / BOX-DOCUMENTS §2.8 G5).
 *
 * Свежий box-проект стартовал с ПУСТОЙ библиотекой шаблонов — фича «Документы»
 * выглядела непонятной с первого входа. Здесь описаны 1–2 самодемонстрирующихся
 * примера: реальный DOCX с `{{переменными}}` из каталога (`document-variables-
 * catalog.ts`), которые движок подставляет при генерации. Файлы генерируются
 * программно (`docx`) — не бинарные ассеты в репозитории — и заливаются в S3 на
 * провижининге, после чего домен публикует шаблон.
 *
 * Плейсхолдеры набраны так, чтобы каждый `{{tag}}` лежал в ОДНОМ текстовом ране
 * (свой `TextRun`), — Word не дробит их по `<w:t>`, поэтому и авто-детект
 * `declared_variables` (BX-DOCS-2), и рендер `docxtemplater` (`{{ }}`-делимитеры)
 * работают надёжно.
 */

export interface SeedTemplateSpec {
  /** Стабильный slug для ключа объекта в S3 (идемпотентность по имени/контексту). */
  slug: string;
  /** Имя шаблона, как увидит пользователь в библиотеке. */
  name: string;
  /** Контекст шаблона: из какого домена тянутся значения переменных. */
  contextType: 'deal' | 'company';
  /** Собрать байты DOCX (валидный OOXML, проходит sanitizeDocxBuffer). */
  build: () => Promise<Buffer>;
}

/** Строка вида «Подпись: {{tag}}» — подпись жирным, плейсхолдер отдельным раном. */
function field(label: string, tag: string): Paragraph {
  return new Paragraph({
    spacing: { after: 120 },
    children: [
      new TextRun({ text: `${label}: `, bold: true }),
      new TextRun({ text: `{{${tag}}}` }),
    ],
  });
}

function heading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 },
    children: [new TextRun({ text, bold: true })],
  });
}

function paragraph(...runs: TextRun[]): Paragraph {
  return new Paragraph({ spacing: { after: 120 }, children: runs });
}

async function toBuffer(children: Paragraph[]): Promise<Buffer> {
  const doc = new Document({ sections: [{ properties: {}, children }] });
  // Packer.toBuffer возвращает Node Buffer — заливаем как есть в S3.
  return (await Packer.toBuffer(doc)) as Buffer;
}

/** «Коммерческое предложение» — контекст «Сделка». */
function commercialProposal(): Promise<Buffer> {
  return toBuffer([
    heading('Коммерческое предложение'),
    field('Проект', 'project.name'),
    field('Дата', 'today'),
    new Paragraph({ text: '' }),
    field('Кому', 'company.name'),
    field('Контактное лицо', 'contact.name'),
    new Paragraph({ text: '' }),
    field('Предмет предложения', 'deal.name'),
    field('Сумма', 'deal.amount'),
    field('Валюта', 'deal.currency'),
    new Paragraph({ text: '' }),
    paragraph(
      new TextRun({
        text: 'Настоящее коммерческое предложение действительно в течение 30 дней с даты составления.',
      }),
    ),
  ]);
}

/** «Реквизиты / шапка договора» — контекст «Компания». */
function companyRequisites(): Promise<Buffer> {
  return toBuffer([
    heading('Реквизиты организации'),
    field('Дата', 'today'),
    new Paragraph({ text: '' }),
    field('Наименование', 'company.name'),
    field('ИНН', 'company.inn'),
    field('КПП', 'company.kpp'),
    field('ОГРН', 'company.ogrn'),
    field('Юридический адрес', 'company.legalAddress'),
    field('Телефон', 'company.phone'),
    field('E-mail', 'company.email'),
  ]);
}

/**
 * Каталог стартовых шаблонов box. Держим 1–2 самых ходовых примера — «пусто из
 * коробки» закрыт, фича понятна с первого входа. Домен провижининга идемпотентно
 * создаёт по одному опубликованному шаблону на каждую запись.
 */
export const SEED_TEMPLATES: SeedTemplateSpec[] = [
  {
    slug: 'commercial-proposal',
    name: 'Коммерческое предложение',
    contextType: 'deal',
    build: commercialProposal,
  },
  {
    slug: 'company-requisites',
    name: 'Реквизиты / шапка договора',
    contextType: 'company',
    build: companyRequisites,
  },
];
