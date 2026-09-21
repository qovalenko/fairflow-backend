import { status } from '@grpc/grpc-js';
import { ChatService } from './chat.service';
import type { ChatCtx } from './chat.types';

/**
 * Юнит-тесты self-leave (be-chat-self-leave): рядовой участник группы/канала
 * должен уметь выйти сам (remove == [self]), не имея прав на управление составом,
 * при этом семантика удаления ЧУЖИХ участников и фиксированный состав DM
 * сохраняются.
 */

type MemberDoc = {
  conversationId: string;
  userId: string;
  role: string;
  leftAt: number | null;
};

const CONV_ID = 'conv-1';
const SCOPE = { kind: 'project', scopeId: 'p1' };

const ctx = (userId: string): ChatCtx =>
  ({ userId, scope: SCOPE, causation: undefined }) as unknown as ChatCtx;

/** Стейтовый мок MongoService для updateMembers/toConversationView. */
function makeMongo(convType: string, members: MemberDoc[]) {
  const conv = {
    _id: CONV_ID,
    type: convType,
    scope: SCOPE,
    createdBy: 'u-owner',
    createdAt: 1,
    updatedAt: 1,
  };
  const match = (m: MemberDoc, f: Record<string, unknown>) =>
    Object.entries(f).every(([k, v]) => {
      if (k === 'leftAt' && v === null) return m.leftAt === null;
      if (v && typeof v === 'object' && '$ne' in (v as object)) {
        return (m as Record<string, unknown>)[k] !== (v as { $ne: unknown }).$ne;
      }
      return (m as Record<string, unknown>)[k] === v;
    });
  const membersColl = {
    findOne: jest.fn(async (f: Record<string, unknown>) => members.find((m) => match(m, f)) ?? null),
    countDocuments: jest.fn(async (f: Record<string, unknown>) =>
      members.filter((m) => match(m, f)).length,
    ),
    updateOne: jest.fn(async (f: Record<string, unknown>, upd: Record<string, unknown>) => {
      const target = members.find((m) => match(m, f));
      if (target && (upd.$set as Record<string, unknown>)?.leftAt !== undefined) {
        target.leftAt = (upd.$set as Record<string, unknown>).leftAt as number;
      }
      return { acknowledged: true };
    }),
    find: jest.fn((f: Record<string, unknown>) => ({
      toArray: async () => members.filter((m) => match(m, f)),
    })),
  };
  const convColl = { findOne: jest.fn(async () => conv), updateOne: jest.fn() };
  return {
    conversations: jest.fn(async () => convColl),
    members: jest.fn(async () => membersColl),
    _membersColl: membersColl,
  } as unknown as {
    conversations: () => Promise<unknown>;
    members: () => Promise<unknown>;
    _membersColl: typeof membersColl;
  };
}

// outbox просто выполняет переданную функцию (без транзакции/сессии).
const outbox = { withOutbox: async (fn: (s?: unknown) => Promise<unknown>) => (await fn()) } as never;
const metrics = { recordChatMessageSent: jest.fn() } as never;

describe('ChatService.updateMembers — self-leave', () => {
  it('рядовой участник группы выходит сам (remove == [self]) — ok', async () => {
    const members: MemberDoc[] = [
      { conversationId: CONV_ID, userId: 'u-owner', role: 'owner', leftAt: null },
      { conversationId: CONV_ID, userId: 'u-member', role: 'member', leftAt: null },
    ];
    const mongo = makeMongo('group', members);
    const svc = new ChatService(mongo as never, outbox, metrics);
    await expect(
      svc.updateMembers(ctx('u-member'), CONV_ID, [], ['u-member'], []),
    ).resolves.toBeDefined();
    // soft-leave проставил leftAt участнику.
    expect(members.find((m) => m.userId === 'u-member')!.leftAt).not.toBeNull();
  });

  it('рядовой участник не может удалить ДРУГОГО участника — PERMISSION_DENIED', async () => {
    const members: MemberDoc[] = [
      { conversationId: CONV_ID, userId: 'u-owner', role: 'owner', leftAt: null },
      { conversationId: CONV_ID, userId: 'u-member', role: 'member', leftAt: null },
      { conversationId: CONV_ID, userId: 'u-other', role: 'member', leftAt: null },
    ];
    const mongo = makeMongo('group', members);
    const svc = new ChatService(mongo as never, outbox, metrics);
    await expect(
      svc.updateMembers(ctx('u-member'), CONV_ID, [], ['u-other'], []),
    ).rejects.toMatchObject({ error: { code: status.PERMISSION_DENIED } });
  });

  it('единственный владелец не может выйти без передачи владения — FAILED_PRECONDITION', async () => {
    const members: MemberDoc[] = [
      { conversationId: CONV_ID, userId: 'u-owner', role: 'owner', leftAt: null },
      { conversationId: CONV_ID, userId: 'u-member', role: 'member', leftAt: null },
    ];
    const mongo = makeMongo('group', members);
    const svc = new ChatService(mongo as never, outbox, metrics);
    await expect(
      svc.updateMembers(ctx('u-owner'), CONV_ID, [], ['u-owner'], []),
    ).rejects.toMatchObject({ error: { code: status.FAILED_PRECONDITION } });
  });

  it('владелец при наличии второго владельца может выйти — ok', async () => {
    const members: MemberDoc[] = [
      { conversationId: CONV_ID, userId: 'u-owner', role: 'owner', leftAt: null },
      { conversationId: CONV_ID, userId: 'u-owner2', role: 'owner', leftAt: null },
    ];
    const mongo = makeMongo('group', members);
    const svc = new ChatService(mongo as never, outbox, metrics);
    await expect(
      svc.updateMembers(ctx('u-owner'), CONV_ID, [], ['u-owner'], []),
    ).resolves.toBeDefined();
  });

  it('из DM выйти нельзя (состав фиксирован) — FAILED_PRECONDITION', async () => {
    const members: MemberDoc[] = [
      { conversationId: CONV_ID, userId: 'u-a', role: 'owner', leftAt: null },
      { conversationId: CONV_ID, userId: 'u-b', role: 'member', leftAt: null },
    ];
    const mongo = makeMongo('dm', members);
    const svc = new ChatService(mongo as never, outbox, metrics);
    await expect(
      svc.updateMembers(ctx('u-a'), CONV_ID, [], ['u-a'], []),
    ).rejects.toMatchObject({ error: { code: status.FAILED_PRECONDITION } });
  });
});
