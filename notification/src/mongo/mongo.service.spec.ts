import { ConfigService } from '@nestjs/config';
import { MongoClient } from 'mongodb';
import { MongoService, NOTIFICATION_RETENTION_TTL_INDEX } from './mongo.service';

jest.mock('mongodb', () => {
  const actual = jest.requireActual('mongodb');
  return { ...actual, MongoClient: jest.fn() };
});

const MongoClientMock = MongoClient as unknown as jest.Mock;

describe('MongoService notification retention index', () => {
  it('creates a TTL index on expires_at (FR-NOTIF-070)', async () => {
    const createIndex = jest.fn(async () => 'ok');
    const updateMany = jest.fn(async () => ({ modifiedCount: 0 }));
    const collection = jest.fn(() => ({
      createIndex,
      updateMany,
    }));
    const service = new MongoService({
      get: () => 'mongodb://localhost:27017/fairflow',
    } as unknown as ConfigService);
    (
      service as unknown as {
        notifications: () => { createIndex: typeof createIndex; updateMany: typeof updateMany };
      }
    ).notifications = collection as never;
    (service as unknown as { preferences: () => { createIndex: typeof createIndex } }).preferences =
      jest.fn(() => ({ createIndex })) as never;
    (
      service as unknown as { scheduledReminders: () => { createIndex: typeof createIndex } }
    ).scheduledReminders = jest.fn(() => ({ createIndex })) as never;

    await (service as unknown as { ensureIndexes: () => Promise<void> }).ensureIndexes();

    expect(createIndex).toHaveBeenCalledWith(
      { expires_at: 1 },
      expect.objectContaining({ expireAfterSeconds: 0, name: NOTIFICATION_RETENTION_TTL_INDEX }),
    );
    expect(updateMany).toHaveBeenCalled();
  });

  it('throws when MONGODB_URI is missing', async () => {
    const service = new MongoService({ get: () => undefined } as unknown as ConfigService);
    await expect(
      (service as unknown as { connectWithRetry: () => Promise<void> }).connectWithRetry(),
    ).rejects.toThrow('MONGODB_URI is required');
  });

  it('connectWithRetry stores client and runs ensureIndexes on success', async () => {
    const createIndex = jest.fn(async () => 'ok');
    const updateMany = jest.fn(async () => ({ modifiedCount: 0 }));
    const ping = jest.fn(async () => undefined);
    const collection = jest.fn(() => ({ createIndex, updateMany }));
    const db = {
      collection,
      admin: () => ({ ping }),
    };
    const close = jest.fn(async () => undefined);
    const connect = jest.fn(async () => undefined);
    MongoClientMock.mockImplementation(() => ({ connect, close, db: () => db, on: jest.fn() }));

    const service = new MongoService({
      get: () => 'mongodb://localhost:27017/fairflow',
    } as unknown as ConfigService);
    await (service as unknown as { connectWithRetry: () => Promise<void> }).connectWithRetry();
    await service.healthPing();
    expect(connect).toHaveBeenCalled();
    expect(createIndex).toHaveBeenCalled();
    expect(ping).toHaveBeenCalled();
    await service.onModuleDestroy();
    expect(close).toHaveBeenCalled();
  });

  it('onModuleDestroy interrupts an in-flight retry wait', async () => {
    jest.useFakeTimers();
    const close = jest.fn(async () => undefined);
    MongoClientMock.mockImplementation(() => ({
      connect: jest.fn(async () => {
        throw new Error('down');
      }),
      close,
      on: jest.fn(),
    }));
    const service = new MongoService({
      get: () => 'mongodb://localhost:27017/fairflow',
    } as unknown as ConfigService);
    const pending = (
      service as unknown as { connectWithRetry: () => Promise<void> }
    ).connectWithRetry();
    await Promise.resolve();
    await service.onModuleDestroy();
    jest.runOnlyPendingTimers();
    await pending;
    jest.useRealTimers();
  });
});
