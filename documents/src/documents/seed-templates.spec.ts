import { sanitizeDocxBuffer, extractDocxPlaceholders } from '@fairflow/shared';
import { SEED_TEMPLATES } from './seed-templates';

/**
 * Стартовые box-шаблоны (BX-DOCS-5) должны проходить ТОТ ЖЕ путь, что и
 * загруженный пользователем DOCX: sanitizeDocxBuffer (FR-MDOC-9/10) на заливке и
 * авто-детект `{{переменных}}` (BX-DOCS-2). Иначе провижининг тихо ничего не
 * посеет (createTemplate бросит TEMPLATE_INVALID), а библиотека останется пустой.
 */
describe('SEED_TEMPLATES', () => {
  it('раскрывает 2 примера — контексты deal и company', () => {
    expect(SEED_TEMPLATES.map((t) => t.contextType).sort()).toEqual(['company', 'deal']);
    // slug'и стабильны и уникальны (ключ объекта в S3 / идемпотентность).
    const slugs = SEED_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  for (const spec of SEED_TEMPLATES) {
    describe(`«${spec.name}» (${spec.contextType})`, () => {
      it('генерирует валидный OOXML/DOCX, проходящий upload-санитайзер', async () => {
        const bytes = await spec.build();
        expect(Buffer.isBuffer(bytes)).toBe(true);
        expect(bytes.length).toBeGreaterThan(0);
        // Не бросает — значит структура OOXML корректна, VBA/XXE/zip-bomb нет.
        expect(() => sanitizeDocxBuffer(bytes)).not.toThrow();
      });

      it('несёт извлекаемые {{плейсхолдеры}} нужного контекста', async () => {
        const bytes = await spec.build();
        const vars = extractDocxPlaceholders(bytes);
        expect(vars.length).toBeGreaterThan(0);
        // Каждый шаблон объявляет хотя бы одну переменную своего домена.
        expect(vars.some((v) => v.startsWith(`${spec.contextType}.`))).toBe(true);
      });
    });
  }

  it('«Коммерческое предложение» объявляет ключевые переменные сделки', async () => {
    const proposal = SEED_TEMPLATES.find((t) => t.slug === 'commercial-proposal');
    const vars = extractDocxPlaceholders(await proposal!.build());
    expect(vars).toEqual(expect.arrayContaining(['deal.name', 'deal.amount']));
  });

  it('«Реквизиты» объявляют обязательные company.name/company.inn', async () => {
    const req = SEED_TEMPLATES.find((t) => t.slug === 'company-requisites');
    const vars = extractDocxPlaceholders(await req!.build());
    expect(vars).toEqual(expect.arrayContaining(['company.name', 'company.inn']));
  });
});
