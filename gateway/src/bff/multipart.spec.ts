import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { readMultipart, MULTIPART_FILE_TOO_LARGE_MESSAGE } from './multipart';

/**
 * m5 — общий хелпер multipart вместо двух дословных копий (crm-bff / v1-data-bff).
 * Тест фиксирует ровно то, из-за чего копии были опасны: обработку лимита размера
 * (оба её проявления — исключение потока и `truncated`) и текст ошибки. Пути самих
 * контроллеров покрыты crm-bff.documents.spec.ts и v1-data-bff.losses.spec.ts.
 */
type Part = {
  type: 'file' | 'field';
  fieldname?: string;
  filename?: string;
  mimetype?: string;
  value?: unknown;
  toBuffer?: () => Promise<Buffer>;
  file?: { truncated?: boolean };
};

function req(parts: Part[] | null): FastifyRequest {
  return {
    isMultipart: () => parts !== null,
    parts: () =>
      (async function* () {
        for (const p of parts ?? []) yield p;
      })(),
  } as unknown as FastifyRequest;
}

describe('readMultipart (gateway/src/bff/multipart.ts)', () => {
  it('returns null for a non-multipart request (JSON path stays alive)', async () => {
    await expect(readMultipart(req(null))).resolves.toBeNull();
  });

  it('reads the first file plus text fields; extra files are ignored', async () => {
    const mp = await readMultipart(
      req([
        { type: 'field', fieldname: 'dedupMode', value: 'update' },
        {
          type: 'file',
          fieldname: 'file',
          filename: 'a.csv',
          mimetype: 'text/csv',
          toBuffer: async () => Buffer.from('a'),
          file: { truncated: false },
        },
        {
          type: 'file',
          fieldname: 'file2',
          filename: 'b.csv',
          toBuffer: async () => Buffer.from('bbb'),
          file: { truncated: false },
        },
        { type: 'field', fieldname: 'empty', value: null },
      ]),
    );
    expect(mp?.buffer?.toString()).toBe('a');
    expect(mp?.filename).toBe('a.csv');
    expect(mp?.mimetype).toBe('text/csv');
    expect(mp?.field('dedupMode')).toBe('update');
    expect(mp?.field('empty')).toBe('');
    expect(mp?.field('absent')).toBeUndefined();
  });

  it('returns a null buffer when the upload carries fields only', async () => {
    const mp = await readMultipart(req([{ type: 'field', fieldname: 'name', value: 'x' }]));
    expect(mp).not.toBeNull();
    expect(mp?.buffer).toBeNull();
    expect(mp?.field('name')).toBe('x');
  });

  it.each(['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT'])(
    'maps a %s stream error to a clean 400 with the size-limit message',
    async (code) => {
      const boom = Object.assign(new Error('too large'), { code });
      const p = readMultipart(
        req([{ type: 'file', fieldname: 'file', toBuffer: async () => Promise.reject(boom) }]),
      );
      await expect(p).rejects.toBeInstanceOf(BadRequestException);
      await expect(p).rejects.toMatchObject({ message: MULTIPART_FILE_TOO_LARGE_MESSAGE });
    },
  );

  it('rejects a silently truncated file with the same message', async () => {
    const p = readMultipart(
      req([
        {
          type: 'file',
          fieldname: 'file',
          toBuffer: async () => Buffer.from('partial'),
          file: { truncated: true },
        },
      ]),
    );
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(p).rejects.toMatchObject({ message: MULTIPART_FILE_TOO_LARGE_MESSAGE });
  });

  it('rethrows a non-limit stream error untouched', async () => {
    const boom = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await expect(
      readMultipart(
        req([{ type: 'file', fieldname: 'file', toBuffer: async () => Promise.reject(boom) }]),
      ),
    ).rejects.toBe(boom);
  });
});
