import { MongoClient, type Db } from 'mongodb';

/**
 * MongoDB integration harness (QA-CI T-026) for the CRM domains (contact, pipe,
 * company, product, …). Runs ONLY when `TEST_MONGO_URL` is set; each run gets its
 * own throwaway `qa_infra_*` database dropped in afterAll. Never touches a stand DB.
 */

export function hasTestMongo(): boolean {
  return !!process.env.TEST_MONGO_URL;
}

export const describeMongoIntegration: jest.Describe = (hasTestMongo()
  ? describe
  : describe.skip) as jest.Describe;

export function ephemeralMongoDbName(label = 'db'): string {
  const safe = label.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20);
  const rand = Math.random().toString(36).slice(2, 8);
  return `qa_infra_${safe}_${Date.now()}_${rand}`;
}

/**
 * Connect to `TEST_MONGO_URL` and hand back a throwaway database plus a teardown
 * that drops it and closes the client. Call `close()` in afterAll.
 */
export async function connectEphemeralMongo(label?: string): Promise<{
  client: MongoClient;
  db: Db;
  dbName: string;
  close: () => Promise<void>;
}> {
  const url = process.env.TEST_MONGO_URL;
  if (!url) throw new Error('TEST_MONGO_URL is not set');
  const dbName = ephemeralMongoDbName(label);
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db(dbName);
  const close = async (): Promise<void> => {
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
  };
  return { client, db, dbName, close };
}
