/**
 * Backfill `stage_transitions` from embedded deal stageLog + crm_deal_stage_history (FR-REPORTS-250).
 *
 *   npx ts-node --transpile-only scripts/backfill-stage-transitions.ts --dry-run
 *   npx ts-node --transpile-only scripts/backfill-stage-transitions.ts
 */
import { MongoClient } from 'mongodb';

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
  const col = db.collection('stage_transitions');

  const ingest = async (doc: Record<string, unknown>) => {
    const projectId = String(doc.projectId ?? '');
    const dealId = String(doc.dealId ?? '');
    const messageId = String(doc.messageId ?? '');
    if (!projectId || !dealId || !messageId) return;
    if (dryRun) return;
    await col.updateOne(
      { projectId, dealId, messageId },
      { $setOnInsert: doc },
      { upsert: true },
    );
  };

  const dealQuery = projectFilter ? { projectId: { $in: [...projectFilter] } } : {};
  const deals = db.collection('crm_deals').find(dealQuery, {
    projection: { projectId: 1, pipelineId: 1, stageLog: 1 },
  });
  for await (const d of deals) {
    const projectId = String(d.projectId ?? '');
    const dealId = String(d._id ?? '');
    const log = (d.stageLog as Array<Record<string, unknown>> | undefined) ?? [];
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      await ingest({
        projectId,
        dealId,
        pipelineId: String(d.pipelineId ?? ''),
        fromStageId: i === 0 ? '' : String(log[i - 1]?.stageId ?? ''),
        toStageId: String(e.stageId ?? ''),
        enteredAt: num(e.enteredAt),
        exitedAt: num(e.exitedAt) || undefined,
        movedBy: String(e.movedBy ?? ''),
        kind: String(e.kind ?? 'move'),
        messageId: `backfill:stageLog:${dealId}:${i}`,
        updatedAt: Date.now(),
      });
    }
  }

  const histQuery = projectFilter ? { projectId: { $in: [...projectFilter] } } : {};
  const hist = db.collection('crm_deal_stage_history').find(histQuery);
  for await (const h of hist) {
    const projectId = String(h.projectId ?? '');
    const dealId = String(h.dealId ?? '');
    const enteredAt = num(h.enteredAt);
    await ingest({
      projectId,
      dealId,
      pipelineId: String(h.pipelineId ?? ''),
      fromStageId: String(h.fromStageId ?? ''),
      toStageId: String(h.toStageId ?? ''),
      enteredAt,
      exitedAt: num(h.exitedAt) || undefined,
      movedBy: String(h.movedBy ?? ''),
      kind: String(h.kind ?? 'move'),
      messageId: `backfill:history:${String(h._id ?? `${dealId}:${enteredAt}`)}`,
      updatedAt: Date.now(),
    });
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}stage_transitions backfill done`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
