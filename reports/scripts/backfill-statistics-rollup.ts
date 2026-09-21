/**
 * Backfill `statistics_rollup` from historical CRM rows (NFR-010).
 *
 *   npx ts-node --transpile-only scripts/backfill-statistics-rollup.ts --dry-run
 *   npx ts-node --transpile-only scripts/backfill-statistics-rollup.ts
 *   npx ts-node --transpile-only scripts/backfill-statistics-rollup.ts --project <id>
 */
import { MongoClient } from 'mongodb';

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const dryRun = process.argv.includes('--dry-run');
  const projectArgIdx = process.argv.indexOf('--project');
  const projectFilter =
    projectArgIdx >= 0 ? new Set([process.argv[projectArgIdx + 1]].filter(Boolean)) : null;

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const rollup = db.collection('statistics_rollup');
  const guard = db.collection('statistics_rollup_msgs');
  const stateCol = db.collection('statistics_rollup_state');

  const earliestByProject = new Map<string, string>();
  const bumpEarliest = (projectId: string, day: string) => {
    if (!projectId || !day) return;
    const cur = earliestByProject.get(projectId);
    if (!cur || day < cur) earliestByProject.set(projectId, day);
  };

  const apply = async (
    projectId: string,
    metric: string,
    day: string,
    count: number,
    amount: number,
    messageId: string,
  ) => {
    bumpEarliest(projectId, day);
    if (dryRun) return;
    const dimsKey = '';
    const claimId = `${projectId}|${metric}|${day}|${dimsKey}|${messageId}`;
    const claim = await guard.updateOne(
      { _id: claimId as never },
      { $setOnInsert: { projectId, metric, at: new Date() } },
      { upsert: true },
    );
    if (claim.upsertedCount === 0) return;
    const now = Date.now();
    await rollup.updateOne(
      { projectId, metric, day, dimsKey },
      {
        $inc: { value: count, amount },
        $set: { updatedAt: now, lastMessageId: messageId, dims: {} },
      },
      { upsert: true },
    );
  };

  const dealQuery = projectFilter ? { projectId: { $in: [...projectFilter] } } : {};
  const deals = db.collection('crm_deals').find(dealQuery);
  for await (const d of deals) {
    const projectId = String(d.projectId ?? '');
    if (!projectId) continue;
    const id = String(d._id ?? '');
    const createdAt = num(d.createdAt ?? d.created_at);
    if (createdAt > 0) {
      await apply(
        projectId,
        'deals_created',
        utcDay(createdAt),
        1,
        num(d.amount),
        `backfill:deal.created:${id}`,
      );
    }
    if (String(d.status) === 'won') {
      const wonAt = num(d.wonAt ?? d.won_at ?? createdAt);
      if (wonAt > 0) {
        await apply(
          projectId,
          'deals_won',
          utcDay(wonAt),
          1,
          num(d.amount),
          `backfill:deal.won:${id}`,
        );
      }
    }
  }

  const orders = db.collection('crm_orders').find(dealQuery);
  for await (const o of orders) {
    const projectId = String(o.projectId ?? '');
    if (!projectId) continue;
    const id = String(o._id ?? '');
    const createdAt = num(o.createdAt ?? o.created_at);
    if (createdAt > 0) {
      await apply(projectId, 'orders_created', utcDay(createdAt), 1, 0, `backfill:order.created:${id}`);
    }
  }

  const activities = db.collection('crm_activities').find(dealQuery);
  for await (const a of activities) {
    const projectId = String(a.projectId ?? '');
    if (!projectId) continue;
    const id = String(a._id ?? '');
    const createdAt = num(a.createdAt ?? a.created_at);
    if (createdAt > 0) {
      await apply(
        projectId,
        'activities_created',
        utcDay(createdAt),
        1,
        0,
        `backfill:activity.created:${id}`,
      );
    }
    if (String(a.status) === 'completed') {
      const doneAt = num(a.completedAt ?? a.updatedAt ?? createdAt);
      if (doneAt > 0) {
        await apply(
          projectId,
          'activities_completed',
          utcDay(doneAt),
          1,
          0,
          `backfill:activity.completed:${id}`,
        );
      }
    }
  }

  if (!dryRun) {
    for (const [projectId, backfilledFromDay] of earliestByProject) {
      await stateCol.updateOne(
        { projectId },
        { $set: { projectId, backfilledFromDay, backfilledAt: Date.now() } },
        { upsert: true },
      );
    }
  }

  const markerSummary = [...earliestByProject.entries()]
    .map(([id, day]) => `${id}:${day}`)
    .join(',');
  console.log(
    `${dryRun ? '[dry-run] ' : ''}statistics_rollup backfill done${
      markerSummary ? `, markers=${markerSummary}` : ''
    }`,
  );
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
