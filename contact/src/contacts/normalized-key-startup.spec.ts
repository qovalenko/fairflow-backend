import { ObjectId } from 'mongodb';
import { runNormalizedKeyStartup } from './normalized-key-startup';

const OID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

describe('runNormalizedKeyStartup (NFR-CONTACTS-070)', () => {
  it('пересчитывает устаревшие ключи и пишет отчёт о коллизиях', async () => {
    const docs = [
      {
        _id: new ObjectId(OID_A),
        projectId: 'p1',
        phone: '+79001112233',
        email: 'dup@x.ru',
        phoneNormalized: '89001112233',
        emailNormalized: 'dup@x.ru',
        createdAt: new Date('2024-01-01'),
      },
      {
        _id: new ObjectId(OID_B),
        projectId: 'p1',
        phone: '+79001112233',
        email: 'dup@x.ru',
        phoneNormalized: '+79001112233',
        emailNormalized: 'dup@x.ru',
        createdAt: new Date('2024-01-02'),
      },
    ];
    const bulkWrites: unknown[] = [];
    const db = {
      collection: (name: string) => {
        if (name === 'contacts_normalize_conflicts') {
          return { bulkWrite: async (ops: unknown) => bulkWrites.push(ops) };
        }
        return {
          distinct: async () => ['p1'],
          find: () => ({
            toArray: async () => docs,
          }),
          bulkWrite: async (ops: unknown) => bulkWrites.push(ops),
        };
      },
    };
    const report = await runNormalizedKeyStartup(db as never, {
      log: () => undefined,
      warn: () => undefined,
    });
    expect(report.updated).toBeGreaterThan(0);
    expect(report.conflicts.length).toBeGreaterThan(0);
    expect(bulkWrites.length).toBeGreaterThan(0);
  });
});
