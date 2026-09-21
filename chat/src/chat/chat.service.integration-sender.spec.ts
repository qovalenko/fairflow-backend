import { status } from '@grpc/grpc-js';
import { ChatService } from './chat.service';
import type { ChatCtx } from './chat.types';

const SCOPE = { kind: 'project', scopeId: 'p1' };
const ctx = (userId: string): ChatCtx =>
  ({ userId, scope: SCOPE, causation: undefined }) as unknown as ChatCtx;

describe('ChatService integration sender (FR-CHAT-430)', () => {
  it('rejects mass mentions from integration sender', async () => {
    const conv = {
      _id: 'c1',
      scope: SCOPE,
      projectId: 'p1',
      title: 'Канал',
      seqCounter: 0,
    };
    const mongo = {
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => conv),
        findOneAndUpdate: jest.fn(),
        updateOne: jest.fn(),
      })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ conversationId: 'c1', userId: 'bot', leftAt: null })),
        find: jest.fn(() => ({ toArray: async () => [] })),
        updateMany: jest.fn(),
      })),
      messages: jest.fn(async () => ({
        findOne: jest.fn(async () => null),
        insertOne: jest.fn(),
      })),
    } as never;
    const outbox = { withOutbox: jest.fn() } as never;
    const metrics = { recordChatMessageSent: jest.fn() } as never;
    const svc = new ChatService(mongo, outbox, metrics);

    await expect(
      svc.sendMessage(ctx('bot'), 'c1', 'hi', 'cid1', [], ['u1', 'u2'], '', 'integration'),
    ).rejects.toMatchObject({ error: { code: status.RESOURCE_EXHAUSTED } });
  });
});
