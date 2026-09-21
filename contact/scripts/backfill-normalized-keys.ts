/**
 * Разовая миграция: пересчёт дедуп-ключей контактов `phoneNormalized` /
 * `emailNormalized` под текущую нормализацию (E.164).
 *
 * ЗАЧЕМ (гейт выкатки домена contact, не примечание).
 * `normalizePhone` теперь приводит номер к `+7…`, а записи, созданные раньше,
 * хранят ключ в старом формате (`89123456789`, `79123456789`). Для Mongo это
 * разные значения, поэтому:
 *  - партиал-уникальный `uniq_project_phone_normalized` не видит конфликта в паре
 *    «старая запись против новой» и пропускает дубль;
 *  - `findDuplicates` (дедуп-радар при вводе) и очередь дублей сводят записи
 *    строго по равенству ключа — такую пару они тоже не показывают.
 * Пока миграция не выполнена, требование о дедупе на существующих данных не
 * выполняется. Поэтому у скрипта есть режим `--check` для прогона в деплое.
 *
 * ЗАПУСК (из `backend/contact`):
 *   npm run db:backfill:normalized -- --dry-run     # только отчёт, без записи
 *   npm run db:backfill:normalized                  # применить
 *   npm run db:backfill:normalized -- --check       # гейт: код 1, если есть непересчитанные
 *   npm run db:backfill:normalized -- --project <id> [--project <id>]
 *   npm run db:backfill:normalized -- --report /tmp/contacts-backfill.json
 * MONGODB_URI берётся из окружения / `contact/.env` / `backend/.env`.
 *
 * ЧТО ДЕЛАЕТ.
 *  1. По каждому проекту берёт ЖИВЫЕ контакты (`deletedAt: null`,
 *     `mergedInto: null`) — у удалённых и у теней слияния ключи сняты намеренно,
 *     трогать их нельзя, иначе они снова займут слот уникального индекса.
 *  2. Считает план через `planNormalizedKeyBackfill` (политика коллизий и выбор
 *     «победителя» — там же, покрыты юнит-тестом).
 *  3. Применяет план `bulkWrite`-пачками, коллизии складывает в коллекцию
 *     `contacts_normalize_conflicts` (плюс печатает и, по флагу, пишет JSON) —
 *     развести их должен человек (merge/правка), автоматически сливать записи
 *     миграция не имеет права.
 *  4. Поднимает уникальные индексы дедупа. Если после пересчёта индекс всё равно
 *     не создаётся — выходит с кодом 1: данные не в том состоянии, которое домен
 *     считает своим инвариантом.
 *
 * Скрипт идемпотентен: повторный запуск на пересчитанных данных даёт 0 изменений.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { MongoClient, ObjectId, type AnyBulkWriteOperation, type Document } from 'mongodb';
import {
  planNormalizedKeyBackfill,
  sourceFieldOf,
  type BackfillDoc,
  type DocPatch,
  type KeyConflict,
  type NormalizedField,
} from '../src/contacts/normalize-backfill';
import { CONTACT_DEDUP_UNIQUE_INDEXES } from '../src/mongo/contact-index-specs';

const contactRoot = path.resolve(__dirname, '..');
const backendRoot = path.resolve(contactRoot, '..');
loadEnv({ path: path.join(contactRoot, '.env') });
loadEnv({ path: path.join(backendRoot, '.env') });

/** Размер пачки bulkWrite: компромисс между числом раундтрипов и размером команды. */
const BULK_BATCH = 500;

interface Options {
  dryRun: boolean;
  check: boolean;
  projects: string[];
  reportPath?: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dryRun: false, check: false, projects: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    // --check — режим гейта: ничего не пишет, но возвращает 1, если пересчёт нужен.
    else if (a === '--check') {
      opts.check = true;
      opts.dryRun = true;
    } else if (a === '--project') {
      const v = argv[++i];
      if (!v) throw new Error('--project требует значение');
      opts.projects.push(v);
    } else if (a === '--report') {
      const v = argv[++i];
      if (!v) throw new Error('--report требует путь к файлу');
      opts.reportPath = v;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'usage: backfill-normalized-keys [--dry-run] [--check] [--project <id>]... [--report <file>]',
      );
      process.exit(0);
    } else {
      throw new Error(`неизвестный аргумент: ${a}`);
    }
  }
  return opts;
}

/** Патчи → операции bulkWrite. `$unset` обязателен: `$set: undefined` драйвер выбрасывает. */
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

function describeConflict(c: KeyConflict): string {
  const on = sourceFieldOf(c.field as NormalizedField);
  return `  project=${c.projectId} ${on}=${c.key} оставлен=${c.keptId} ключ снят у: ${c.droppedIds.join(', ')}`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    console.error('MONGODB_URI обязателен (окружение, contact/.env или backend/.env).');
    process.exit(2);
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const coll = client.db().collection('contacts');

  // Живые записи: тени слияния и корзина держат ключи снятыми специально.
  const liveFilter: Record<string, unknown> = { deletedAt: null, mergedInto: null };
  const projects = opts.projects.length
    ? opts.projects
    : ((await coll.distinct('projectId', liveFilter)) as string[]).filter(Boolean);

  let scanned = 0;
  let updated = 0;
  const allConflicts: KeyConflict[] = [];

  for (const projectId of projects) {
    // По одному проекту за раз: группировка по ключу требует держать ключевое
    // пространство проекта в памяти, но проекция — только пять полей.
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

    if (!plan.patches.length) {
      console.log(`project ${projectId}: ${docs.length} записей, изменений нет`);
      continue;
    }
    updated += plan.patches.length;
    if (opts.dryRun) {
      console.log(
        `project ${projectId}: ${docs.length} записей, требуется пересчитать ${plan.patches.length} (dry-run)`,
      );
      continue;
    }
    const ops = toBulkOps(plan.patches);
    for (let i = 0; i < ops.length; i += BULK_BATCH) {
      // ordered:false — одна упавшая операция не должна отменять остальную пачку.
      await coll.bulkWrite(ops.slice(i, i + BULK_BATCH), { ordered: false });
    }
    console.log(`project ${projectId}: ${docs.length} записей, пересчитано ${plan.patches.length}`);
  }

  // Отчёт о коллизиях: их разводит человек, поэтому он должен пережить сессию.
  if (allConflicts.length && !opts.dryRun) {
    const conflictsColl = client.db().collection('contacts_normalize_conflicts');
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
  }

  console.log(
    `\nИтого: проектов ${projects.length}, просмотрено ${scanned}, ` +
      `${opts.dryRun ? 'требует пересчёта' : 'пересчитано'} ${updated}, коллизий ${allConflicts.length}`,
  );
  if (allConflicts.length) {
    console.log(
      'Коллизии (две живые записи схлопнулись в один ключ; ключ оставлен одной, остальные\n' +
        'выпали из дедупа и ждут ручного слияния — см. коллекцию contacts_normalize_conflicts):',
    );
    for (const c of allConflicts.slice(0, 50)) console.log(describeConflict(c));
    if (allConflicts.length > 50) console.log(`  … и ещё ${allConflicts.length - 50}`);
  }

  if (opts.reportPath) {
    fs.writeFileSync(
      opts.reportPath,
      JSON.stringify(
        { at: new Date().toISOString(), scanned, updated, conflicts: allConflicts },
        null,
        2,
      ),
    );
    console.log(`Отчёт: ${opts.reportPath}`);
  }

  // Гейт: после пересчёта уникальные индексы обязаны встать. Если не встают —
  // данные всё ещё содержат живой дубль по ключу, и домен нельзя выкатывать.
  let indexFailure: string | null = null;
  if (!opts.dryRun) {
    for (const spec of CONTACT_DEDUP_UNIQUE_INDEXES) {
      try {
        await coll.createIndex(spec.key, spec.opts);
      } catch (err) {
        indexFailure = `${String(spec.opts.name)}: ${(err as Error).message}`;
        console.error(`НЕ УДАЛОСЬ создать уникальный индекс ${indexFailure}`);
      }
    }
  }

  await client.close();

  if (indexFailure) process.exit(1);
  if (opts.check && updated > 0) {
    console.error('\n--check: есть непересчитанные ключи, миграция не выполнена.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
