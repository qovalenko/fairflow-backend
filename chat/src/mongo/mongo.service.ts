import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Collection, Db, MongoClient } from 'mongodb';

/**
 * MongoDB connection + chat collections (contracts/chat.md §9.1, M-CHAT-4):
 * `conversations`, `conversation_members`, `messages` (+ `_outbox` for the
 * transactional outbox). Postgres is not used (CRM/Mongo domain).
 */
@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MongoService.name);
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private connectPromise: Promise<void> | null = null;
  // Retry-loop control (P0-4): flag + timer/resolver so onModuleDestroy can stop
  // the backoff loop cleanly without leaving a dangling timer (jest/graceful shutdown).
  private destroyed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolve: (() => void) | null = null;

  /**
   * Не блокируем Nest bootstrap. connectPromise — это промис всего retry-цикла
   * (P0-4): он резолвится, когда Mongo наконец поднялся; хендлеры ждут ready().
   */
  onModuleInit(): void {
    this.connectPromise = this.connectWithRetry();
    void this.connectPromise.catch(() => undefined);
  }

  /**
   * Connect to MongoDB with exponential backoff (1s → 2s → 4s … cap 30s), retrying
   * forever until success or onModuleDestroy (P0-4). A one-shot connect left the
   * pod permanently NotReady if Mongo was down at boot; this self-heals. Index
   * setup failures also trigger a retry of the whole cycle.
   */
  private async connectWithRetry(): Promise<void> {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI is required');
    }
    let attempt = 0;
    let delayMs = 1_000;
    while (!this.destroyed) {
      attempt += 1;
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 10_000,
        connectTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
      });
      try {
        await client.connect();
        if (this.destroyed) {
          await client.close().catch(() => undefined);
          return;
        }
        this.client = client;
        this.db = client.db();
        this.logger.log('MongoDB connected');
        await this.ensureIndexes();
        return;
      } catch (err) {
        await client.close().catch(() => undefined);
        this.client = null;
        this.db = null;
        if (this.destroyed) return;
        this.logger.warn(
          `MongoDB connection attempt ${attempt} failed; retrying in ${delayMs}ms: ${(err as Error).message}`,
        );
        await this.wait(delayMs);
        delayMs = Math.min(delayMs * 2, 30_000);
      }
    }
  }

  /** Interruptible backoff sleep: onModuleDestroy clears the timer and resolves. */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.retryResolve = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.retryResolve = null;
        resolve();
      }, ms);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.retryResolve) {
      this.retryResolve();
      this.retryResolve = null;
    }
    if (this.client) {
      await this.client.close().catch(() => undefined);
      this.client = null;
      this.db = null;
      this.connectPromise = null;
    }
  }

  async ready(): Promise<void> {
    if (!this.connectPromise) throw new Error('MongoDB not started');
    await this.connectPromise;
  }

  /** Indexes per contracts/chat.md §9.1. Best-effort: never blocks listeners. */
  private async ensureIndexes(): Promise<void> {
    if (!this.db) return;
    const conv = this.db.collection('conversations');
    const members = this.db.collection('conversation_members');
    const messages = this.db.collection('messages');
    const tasks: Array<Promise<unknown>> = [
      // conversations: unique DM by dmKey (partial, type=dm); scope/project sort.
      conv.createIndex(
        { dmKey: 1 },
        { unique: true, partialFilterExpression: { type: 'dm' }, name: 'uniq_dm_key' },
      ),
      conv.createIndex({ projectId: 1, lastMessageAt: -1 }, { name: 'project_lastMessageAt' }),
      conv.createIndex({ 'scope.scopeId': 1, lastMessageAt: -1 }, { name: 'scope_lastMessageAt' }),
      // conversation_members: membership gate, list+badge, member fan-out.
      members.createIndex({ conversationId: 1, userId: 1 }, { unique: true, name: 'uniq_conv_user' }),
      members.createIndex({ userId: 1, leftAt: 1 }, { name: 'user_leftAt' }),
      members.createIndex({ conversationId: 1, leftAt: 1 }, { name: 'conv_leftAt' }),
      // messages: keyset pagination, send-dedup, isolation, FTS (v1.x).
      messages.createIndex({ conversationId: 1, seq: 1 }, { name: 'conv_seq' }),
      messages.createIndex(
        { conversationId: 1, clientMessageId: 1 },
        { unique: true, name: 'uniq_conv_clientMessageId' },
      ),
      messages.createIndex({ projectId: 1 }, { name: 'project' }),
      messages.createIndex({ text: 'text' }, { name: 'text_fts' }),
      messages.createIndex(
        { 'entityRefs.type': 1, 'entityRefs.id': 1 },
        { name: 'entity_refs_lookup' },
      ),
    ];
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'rejected') {
        this.logger.warn(`failed to ensure chat index: ${String(r.reason)}`);
      }
    }
  }

  getDb(): Db {
    if (!this.db) throw new Error('MongoDB not connected yet');
    return this.db;
  }

  async conversations(): Promise<Collection<ConversationDoc>> {
    await this.ready();
    return this.getDb().collection<ConversationDoc>('conversations');
  }

  async members(): Promise<Collection<ConversationMemberDoc>> {
    await this.ready();
    return this.getDb().collection<ConversationMemberDoc>('conversation_members');
  }

  async messages(): Promise<Collection<MessageDoc>> {
    await this.ready();
    return this.getDb().collection<MessageDoc>('messages');
  }

  /** Transactional-outbox collection (E3-01, RFC-4 §Р-4). */
  async outbox(): Promise<Collection<OutboxRowDoc>> {
    await this.ready();
    return this.getDb().collection<OutboxRowDoc>('_outbox');
  }

  /** Underlying client (for sessions / transactions). */
  getClient(): MongoClient {
    if (!this.client) throw new Error('MongoDB not connected yet');
    return this.client;
  }

  async healthPing(): Promise<void> {
    await this.ready();
    await this.getDb().admin().ping();
  }
}

/** Isolation scope of a conversation (contracts/chat.md §1/§9.1). */
export interface ScopeDoc {
  kind: 'project' | 'org' | 'workspace';
  scopeId: string;
}

export interface LastMessageDoc {
  id: string;
  text: string;
  senderId: string;
  sentAt: number;
  kind: string;
}

export interface AttachmentDoc {
  documentId: string;
  versionId: string;
  fileName: string;
  mime: string;
  size: number;
}

/** CRM entity ref stored on messages (FR-CHAT-440). */
export interface EntityRefDoc {
  type: 'deal' | 'contact' | 'company' | 'order';
  id: string;
  label: string;
}

/** `conversations` (contracts/chat.md §9.1). `_id` is a UUIDv7 string. */
export interface ConversationDoc {
  _id: string;
  type: 'dm' | 'group' | 'project_channel';
  scope: ScopeDoc;
  projectId: string | null;
  title?: string;
  avatarUrl?: string;
  dmKey?: string;
  createdBy: string;
  lastMessage?: LastMessageDoc | null;
  lastMessageAt?: number;
  seqCounter: number;
  retentionPolicy?: { days: number; source: string };
  archivedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/** `conversation_members` (contracts/chat.md §9.1). */
export interface ConversationMemberDoc {
  _id: string;
  conversationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: number;
  leftAt?: number | null;
  lastReadSeq: number;
  lastReadAt?: number | null;
  unreadCount: number;
  mutedUntil?: number | null;
}

/** `messages` (contracts/chat.md §9.1). `_id` is a UUIDv7 string. */
export interface MessageDoc {
  _id: string;
  conversationId: string;
  scope: ScopeDoc;
  projectId: string | null;
  seq: number;
  senderId: string;
  senderType: 'user' | 'integration' | 'system';
  kind: 'text' | 'system';
  text: string;
  attachments: AttachmentDoc[];
  mentionIds: string[];
  entityRefs?: EntityRefDoc[];
  replyToId?: string | null;
  clientMessageId: string;
  editedAt?: number | null;
  deletedAt?: number | null;
  deletedBy?: string | null;
  sentAt: number;
  createdAt: number;
}

/** Stored shape of a transactional-outbox row (mirrors `OutboxRow` from shared). */
export interface OutboxRowDoc {
  _id?: import('mongodb').ObjectId;
  messageId: string;
  routingKey: string;
  projectId?: string;
  status: 'pending' | 'published' | 'failed';
  attempts: number;
  envelope: unknown;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
}
