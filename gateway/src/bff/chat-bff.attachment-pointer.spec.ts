/**
 * X4 (chat) — the legacy JSON branch of `POST /api/chat/attachments` used to take
 * `bucket` + `objectKey` from the request body verbatim and hand them to the very
 * same `documents.uploadDocument` the CRM BFF guards with `trustedClientPointer`.
 * The documents domain checks those two for non-emptiness only on write, so an
 * unguarded body let any conversation member register (and later presign) an
 * object in ANY bucket the documents service's S3 credentials reach, at any key.
 *
 * These tests pin the boundary: one allowed bucket, and a key that must live under
 * THIS conversation's prefix (`{projectId}/chat/{conversationId}/`), which is what
 * the multipart branch writes.
 */
import { of } from 'rxjs';
import { BadRequestException } from '@nestjs/common';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { ChatBffController } from './chat-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

const DOCUMENTS_BUCKET = 'fairflow-documents';
const PROJECT = 'proj-1';
const CONV = 'conv-1';

function build(documentsService: Record<string, unknown>) {
  const chat = { getConversation: jest.fn(() => of({ id: CONV })) };
  const ctrl = new ChatBffController(
    stubClient(chat), // chat
    stubClient(documentsService), // documents
    stubClient(), // control
    { build: () => ({}) } as never, // outbound metadata
    {} as never, // chat stream
    {} as never, // attachment storage (multipart branch only)
    { s3DocumentsBucket: DOCUMENTS_BUCKET } as never, // config (X4)
    { recordChatMessageSent: jest.fn() } as never, // metrics
  );
  ctrl.onModuleInit();
  return ctrl;
}

// A plain JSON request (no isMultipart) → the legacy pointer branch.
const req = { user: { userId: 'u1' }, headers: {} } as never;

describe('X4 — chat attachment pointer from the request body', () => {
  it('refuses a foreign bucket and registers nothing', async () => {
    const uploadDocument = jest.fn(() => of({}));
    const ctrl = build({ uploadDocument });
    await expect(
      ctrl.uploadAttachment(
        req,
        {
          conversationId: CONV,
          bucket: 'attacker-controlled',
          objectKey: `${PROJECT}/chat/${CONV}/f.pdf`,
        },
        PROJECT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('refuses a key belonging to another conversation in the same project', async () => {
    const uploadDocument = jest.fn(() => of({}));
    const ctrl = build({ uploadDocument });
    await expect(
      ctrl.uploadAttachment(
        req,
        {
          conversationId: CONV,
          bucket: DOCUMENTS_BUCKET,
          objectKey: `${PROJECT}/chat/conv-other/secret.pdf`,
        },
        PROJECT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('refuses a key outside the project prefix', async () => {
    const uploadDocument = jest.fn(() => of({}));
    const ctrl = build({ uploadDocument });
    await expect(
      ctrl.uploadAttachment(
        req,
        { conversationId: CONV, objectKey: `other-project/chat/${CONV}/secret.pdf` },
        PROJECT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('fills the bucket in from config when the body omits it', async () => {
    const uploadDocument = jest.fn((_payload: Record<string, unknown>) =>
      of({ group: { group_id: 'g1' }, version: {} }),
    );
    const ctrl = build({ uploadDocument });
    await ctrl.uploadAttachment(
      req,
      { conversationId: CONV, objectKey: `${PROJECT}/chat/${CONV}/f.pdf`, sizeBytes: 3 },
      PROJECT,
    );
    const sent = uploadDocument.mock.calls[0][0];
    expect(sent.bucket).toBe(DOCUMENTS_BUCKET);
    expect(sent.object_key).toBe(`${PROJECT}/chat/${CONV}/f.pdf`);
    expect(sent.project_id).toBe(PROJECT);
  });

  it('requires a projectId (an empty one would degrade the prefix check)', async () => {
    const uploadDocument = jest.fn(() => of({}));
    const ctrl = build({ uploadDocument });
    await expect(
      ctrl.uploadAttachment(req, { conversationId: CONV, objectKey: '/chat/x/f.pdf' }, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadDocument).not.toHaveBeenCalled();
  });
});
