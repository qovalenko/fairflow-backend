import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Максимальный размер загружаемого файла, как он зарегистрирован в
 * `@fastify/multipart` (application.ts). Текст лимита живёт рядом со значением,
 * чтобы при смене лимита не осталось расходящихся сообщений в контроллерах.
 */
export const MULTIPART_FILE_TOO_LARGE_MESSAGE = 'файл превышает лимит размера 20 МБ';

/** Результат разбора multipart-запроса. */
export type MultipartUpload = {
  buffer: Buffer | null;
  filename?: string;
  mimetype?: string;
  field: (k: string) => string | undefined;
};

/**
 * Read a multipart upload off a Fastify request into memory (BX-DOCS-1 /
 * FR-COMPANIES-440). Returns the (optional) file buffer + parsed form fields, or
 * `null` when the request is a plain JSON body (legacy pre-uploaded-pointer path).
 * Uses `req.parts()` so the file part is OPTIONAL — a metadata-only template edit
 * sends fields with no file. The 20 MB `@fastify/multipart` limit is enforced; an
 * oversized stream maps to a clean 400.
 *
 * Нужен потому, что multipart зарегистрирован БЕЗ `attachFieldsToBody`
 * (application.ts) — `@Body()` для такого запроса пустой/415.
 *
 * m5: единственная копия хелпера — crm-bff и v1-data-bff вызывают именно её,
 * чтобы обработка лимита и текст ошибки не разъехались.
 */
export async function readMultipart(req: FastifyRequest): Promise<MultipartUpload | null> {
  const isMultipart =
    typeof (req as unknown as { isMultipart?: () => boolean }).isMultipart === 'function' &&
    (req as unknown as { isMultipart: () => boolean }).isMultipart();
  if (!isMultipart) return null;

  type Part = {
    type: 'file' | 'field';
    fieldname?: string;
    filename?: string;
    mimetype?: string;
    value?: unknown;
    toBuffer?: () => Promise<Buffer>;
    file?: { truncated?: boolean };
  };
  const parts = (req as unknown as { parts: () => AsyncIterable<Part> }).parts();

  const fields: Record<string, string> = {};
  let buffer: Buffer | null = null;
  let filename: string | undefined;
  let mimetype: string | undefined;

  for await (const part of parts) {
    if (part.type === 'file' && typeof part.toBuffer === 'function') {
      let buf: Buffer;
      try {
        buf = await part.toBuffer(); // consuming the stream is required to advance
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
          throw new BadRequestException(MULTIPART_FILE_TOO_LARGE_MESSAGE);
        }
        throw error;
      }
      if (part.file?.truncated) {
        throw new BadRequestException(MULTIPART_FILE_TOO_LARGE_MESSAGE);
      }
      // Only the first file part is used; ignore any extras.
      if (buffer === null) {
        buffer = buf;
        filename = part.filename;
        mimetype = part.mimetype;
      }
    } else if (part.fieldname != null) {
      fields[part.fieldname] = part.value == null ? '' : String(part.value);
    }
  }

  const field = (k: string): string | undefined => (k in fields ? fields[k] : undefined);
  return { buffer, filename, mimetype, field };
}
