/**
 * CANON §2 backfill — legacy `crm_products` rows missing v1 fields.
 *
 * Usage:
 *   npm run db:backfill:legacy -- --dry-run
 *   npm run db:backfill:legacy
 *   npm run db:backfill:legacy -- --check
 *   npm run db:backfill:legacy -- --project <id>
 */
import { MongoClient } from 'mongodb';

type Args = {
  dryRun: boolean;
  check: boolean;
  projects: string[];
};

function parseArgs(argv: string[]): Args {
  const projects: string[] = [];
  let dryRun = false;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--check') check = true;
    else if (a === '--project') projects.push(argv[++i] ?? '');
  }
  return { dryRun, check, projects: projects.filter(Boolean) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL ?? process.env.MONGODB_URL;
  if (!url) {
    console.error('DATABASE_URL or MONGODB_URL is required');
    process.exit(1);
  }
  const client = new MongoClient(url);
  await client.connect();
  const coll = client.db().collection('crm_products');
  const filter: Record<string, unknown> = {
    $or: [
      { status: { $exists: false } },
      { currency: { $in: [null, ''] } },
      { orderTypeDangling: { $exists: false } },
      { effectivePrice: { $exists: false } },
    ],
  };
  if (args.projects.length) filter.projectId = { $in: args.projects };

  const pending = await coll.countDocuments(filter);
  if (args.check) {
    if (pending > 0) {
      console.error(`backfill pending: ${pending} product(s)`);
      process.exit(1);
    }
    console.log('backfill check ok');
    await client.close();
    return;
  }

  console.log(`${args.dryRun ? '[dry-run] ' : ''}legacy products to backfill: ${pending}`);
  if (pending === 0 || args.dryRun) {
    await client.close();
    return;
  }

  const cursor = coll.find(filter);
  let updated = 0;
  while (await cursor.hasNext()) {
    const doc = (await cursor.next()) as Record<string, unknown> | null;
    if (!doc) continue;
    const set: Record<string, unknown> = { updatedAt: Date.now() };
    if (doc.status == null) set.status = 'active';
    if (doc.currency == null || doc.currency === '') set.currency = 'RUB';
    if (doc.orderTypeDangling == null) set.orderTypeDangling = false;
    if (doc.effectivePrice == null) set.effectivePrice = Number(doc.price ?? 0);
    await coll.updateOne({ _id: doc._id }, { $set: set });
    updated += 1;
  }
  console.log(`backfill applied to ${updated} product(s)`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
