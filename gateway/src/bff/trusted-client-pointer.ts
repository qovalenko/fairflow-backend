import { BadRequestException } from '@nestjs/common';

/** The storage pointer forwarded to `documents` (bucket/objectKey + file facts). */
export interface TrustedClientPointer {
  bucket: string;
  objectKey: string;
  fileHash: unknown;
  sizeBytes: unknown;
  mimeType: unknown;
}

/**
 * X4 — a storage pointer that arrived in the request BODY (the JSON/back-compat
 * branch of the upload routes) is client input, not a fact.
 *
 * `bucket` + `objectKey` are an ADDRESS: the documents domain persists them and
 * later reads (`getObjectBuffer` when validating a template revision) and
 * presigns (`presignDownload`) from exactly that address. The domain validates
 * only the KEY (`objectKey.startsWith(projectId/)`), and only on the READ paths —
 * `uploadDocument` checks bucket/objectKey for non-emptiness alone. So a caller
 * could point the domain at any bucket its S3 credentials can reach and have it
 * fetch/sign an object from there. That is the "client chooses the storage
 * endpoint" class — an SSRF neighbour.
 *
 * Closed on the allowlist of exactly one entry: the configured documents bucket.
 * An absent bucket is filled in (back-compat: the domain rejects an empty one);
 * a DIFFERENT bucket is refused loudly rather than silently rewritten, because a
 * silent rewrite would make the domain fetch an object that is not the one the
 * caller named. The key is additionally held to `requiredKeyPrefix` — the same
 * `projectId/` prefix the domain enforces on reads, so the two agree at the
 * boundary instead of one of them trusting the other; callers that own a
 * narrower key layout (chat attachments live under
 * `{projectId}/chat/{conversationId}/`) pass that longer prefix instead, because
 * for them "somewhere else in my project" is still someone else's object.
 *
 * Lives outside the controllers because BOTH the CRM BFF (document/template
 * uploads) and the chat BFF (attachment registration) hand a body-supplied
 * pointer to the very same `documents.uploadDocument`; one copy means one place
 * where the allowlist can be got wrong.
 */
export function trustedClientPointer(params: {
  /** The single bucket the gateway is configured to write documents into. */
  allowedBucket: string;
  /** Key prefix the caller is authorized for, e.g. `${projectId}/`. */
  requiredKeyPrefix: string;
  body: Record<string, unknown>;
  defaultMime: string;
}): TrustedClientPointer {
  const { allowedBucket, requiredKeyPrefix, body, defaultMime } = params;
  const claimedBucket = String(body.bucket ?? '').trim();
  if (claimedBucket && claimedBucket !== allowedBucket) {
    throw new BadRequestException({
      code: 'BUCKET_NOT_ALLOWED',
      message: 'bucket is not accepted from the request body',
    });
  }
  const objectKey = String(body.objectKey ?? '').trim();
  // An empty key means "no pointer supplied" (e.g. a metadata-only template
  // rename): pass it through and let the domain decide whether it was required.
  if (objectKey && !objectKey.startsWith(requiredKeyPrefix)) {
    throw new BadRequestException({
      code: 'OBJECT_KEY_NOT_ALLOWED',
      message: 'objectKey must live under the authorized project prefix',
    });
  }
  return {
    // Only name the bucket when there is an object to name it for, so a
    // metadata-only body keeps its current "no pointer" shape.
    bucket: objectKey ? allowedBucket : claimedBucket,
    objectKey,
    fileHash: body.fileHash ?? '',
    sizeBytes: body.sizeBytes ?? 0,
    mimeType: body.mimeType ?? defaultMime,
  };
}
