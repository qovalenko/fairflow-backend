/**
 * NFR-CONTACTS-070: auto-backfill normalized dedup keys on domain startup (BOX
 * upgrade path). Wraps the same planner as `scripts/backfill-normalized-keys.ts`
 * so operators are not required to run the script manually before indexes land.
 */
import { ObjectId, type AnyBulkWriteOperation, type Db, type Document } from 'mongodb';
import {
  planNormalizedKeyBackfill,
  type BackfillDoc,
  type DocPatch,
  type KeyConflict,
} from './normalize-backfill';

const BULK_BATCH = 500;

type LoggerLike = {
  log: (msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

function toBulkOps(patches: DocPatch[]): AnyBulkWriteOperation<Document>[] {
  return patches.map((p) => {
    const update: Record<string, unknown> = {};
    if (Object.keys(p.set).length) update.$set = p.set;
    if (p.unset.length) {
      update.$unset = Object.fromEntries(p.unset.map((f) => [f, '']));
    }
    return { updateOne: { filter: { _id: new ObjectId(p.id) }, update } };
  });
}

export interface NormalizedKeyStartupReport {
  projects: number;
  scanned: number;
  updated: number;
  conflicts: KeyConflict[];
}

/** Idempotent: safe on every boot; no-op when keys are already current. */
export async function runNormalizedKeyStartup(
  db: Db,
  logger: LoggerLike,
): Promise<NormalizedKeyStartupReport> {
  const coll = db.collection('contacts');
  const liveFilter: Record<string, unknown> = { deletedAt: null, mergedInto: null };
  const projects = ((await coll.distinct('projectId', liveFilter)) as string[]).filter(Boolean);

  let scanned = 0;
  let updated = 0;
  const allConflicts: KeyConflict[] = [];

  for (const projectId of projects) {
    const docs = (await coll
      .find(
        { ...liveFilter, projectId },
        {
          projection: {
            _id: 1,
            projectId: 1,
            phone: 1,
            email: 1,
            phoneNormalized: 1,
            emailNormalized: 1,
            createdAt: 1,
          },
        },
      )
      .toArray()) as unknown as (Omit<BackfillDoc, 'id'> & { _id: ObjectId })[];
    scanned += docs.length;

    const plan = planNormalizedKeyBackfill(
      docs.map((d) => ({
        id: d._id.toString(),
        projectId: d.projectId,
        phone: d.phone,
        email: d.email,
        phoneNormalized: d.phoneNormalized,
        emailNormalized: d.emailNormalized,
        createdAt: d.createdAt,
      })),
    );
    allConflicts.push(...plan.conflicts);

    if (!plan.patches.length) continue;
    updated += plan.patches.length;
    const ops = toBulkOps(plan.patches);
    for (let i = 0; i < ops.length; i += BULK_BATCH) {
      await coll.bulkWrite(ops.slice(i, i + BULK_BATCH), { ordered: false });
    }
    logger.log(`normalized-key startup: project ${projectId} patched ${plan.patches.length} docs`);
  }

  if (allConflicts.length) {
    const conflictsColl = db.collection('contacts_normalize_conflicts');
    const now = new Date();
    await conflictsColl.bulkWrite(
      allConflicts.map((c) => ({
        updateOne: {
          filter: { projectId: c.projectId, field: c.field, key: c.key },
          update: {
            $set: { ...c, detectedAt: now, resolvedAt: null },
            $setOnInsert: { firstDetectedAt: now },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    logger.warn(
      { count: allConflicts.length, sample: allConflicts.slice(0, 5) },
      'normalized-key startup: collisions detected before unique indexes',
    );
  }

  return { projects: projects.length, scanned, updated, conflicts: allConflicts };
}
