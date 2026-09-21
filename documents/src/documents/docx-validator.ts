import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import {
  sanitizeDocxBuffer,
  DocxValidationError,
  type DocxRejectReason,
  type DocxZipEntry,
} from '@fairflow/shared';

/**
 * DOCX (OOXML) upload sanitizer — FR-MDOC-9/10, SEC §3.3/§3.4, CONFORMANCE C3.
 *
 * The pure, framework-agnostic validation core now lives in `@fairflow/shared`
 * (`sanitizeDocxBuffer`) so the gateway BFF can reject unsafe files BEFORE they
 * reach S3 while this domain remains the authoritative gate on the stored bytes.
 * This wrapper preserves the domain contract: any rejection is surfaced as
 * `TEMPLATE_INVALID` (mapped to HTTP 422 at the gateway) with `details.reason`.
 */
export type { DocxRejectReason };

@Injectable()
export class DocxValidator {
  private readonly logger = new Logger(DocxValidator.name);

  /**
   * Validate a buffer that should be a safe DOCX template. Throws on any unsafe
   * pattern; returns the parsed entry list on success (callers may ignore it).
   */
  validate(buf: Buffer): { entries: DocxZipEntry[] } {
    try {
      return sanitizeDocxBuffer(buf);
    } catch (err) {
      if (err instanceof DocxValidationError) {
        throw new RpcException({
          code: status.INVALID_ARGUMENT,
          message: err.message,
          // surfaced as details.reason at the gateway for the FR-MDOC-9/10 contract.
          details: { code: 'TEMPLATE_INVALID', reason: err.reason },
        } as never);
      }
      throw err;
    }
  }
}
