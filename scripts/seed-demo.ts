/**
 * Rich, connected DEMO seed for a Fairflow stand — makes the admin look like a
 * real, lived-in CRM: products / companies / contacts / a deal funnel spread
 * across stages and ~6 months, won/lost deals, orders (sales) on won deals,
 * activities (calls/meetings/tasks, some overdue / done) and an audit history.
 *
 * Everything is CROSS-LINKED so the statistics screens actually compute:
 *   contact.companyIds → company._id
 *   deal.contactId/companyId/productId → contact/company/product
 *   order.dealId/productId/contactId/companyId → deal/product/contact/company
 *   activity.links[] → deal/contact/company/order
 *
 * Writes DIRECTLY to MongoDB (the dashboards in `reports`/`pipe` read the
 * collections, not the bus — so a direct insert is enough; the seed deliberately
 * does NOT go through the outbox/event bus).
 *
 * STATISTICS CONTRACT (verified against reports.service.ts / pipe.service.ts):
 *   - Funnel        = crm_deals grouped by `stageId`     → needs real pipeline stage ids.
 *   - Won KPI       = crm_deals where `stageId === 'won'` (reports) AND `status === 'won'` (pipe).
 *   - Sources       = crm_deals grouped by `source` (string) → human-readable names.
 *   - Sales / KPI   = crm_deals `amount` + `createdAt` (period window; default = current month).
 *   - Team          = crm_deals grouped by `assigneeId`.
 *   - Conversion    = crm_deals `status` won/lost + `wonAt`/`lostAt` + `createdAt`.
 *   - Dashboard lists = crm_activities `dueAt` + `ownerId` + `status` (overdue/upcoming/recent).
 *   - Order types   = crm_order_types + active orders (crm_orders `status` ACTIVE) per typeId.
 * The seed writes BOTH the pipe spelling (`assigneeId`,`dueDate`) and the reports
 * spelling (`ownerId`,`dueAt`) where they differ, so every reader gets data.
 *
 * HISTORY ("История изменений"):
 *   - crm_deals.stageLog[]            — stored on every deal (forward-compatible).
 *   - crm_deal_stage_history          — one row per stage transition.
 *   - audit_events (appendEvent/toRow shape) — the surface `/api/v1/audit/events`
 *     returns; one row per created/stage-changed/won/order-created fact, filterable
 *     by entityType+entityId for per-record history.
 *
 * IDEMPOTENCY: every document gets a DETERMINISTIC _id (md5(namespace) → ObjectId),
 * so a re-run upserts in place instead of duplicating. Safe to run many times.
 *
 * Usage (from backend/):
 *   MONGODB_URI='mongodb://user:pass@host:27017/fairflow?authSource=admin' \
 *   SEED_PROJECT_ID=019f0440-0b9b-74dd-b646-003e7eb7997e \
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/seed-demo.ts
 *
 * Or via npm:
 *   npm run db:seed:demo
 *
 * Env:
 *   MONGODB_URI        Mongo connection (default: from .fairflow-dev.env / .env)
 *   SEED_PROJECT_ID    target project (default: live v1 project, see below)
 *   SEED_OWNER_ID      primary owner/assignee (default: admin, see below)
 *   SEED_ASSIGNEE_IDS  comma-separated extra assignee user ids (team breakdown);
 *                      defaults to SEED_OWNER_ID only. Pass the real test-user ids
 *                      (anna/dmitry/sergey/maria/elena/igor) for a richer team chart.
 *   SEED_DEMO_WIPE=1   delete this seed's demo docs (by deterministic id namespace)
 *                      before re-inserting (otherwise pure upsert).
 */
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { MongoClient, ObjectId, type Db } from 'mongodb';

const servicesRoot = path.resolve(__dirname, '..');
loadEnv({ path: path.join(servicesRoot, '.fairflow-dev.env') });
loadEnv({ path: path.join(servicesRoot, '.env') });

// ───────────────────────────── configuration ─────────────────────────────

const PROJECT_ID =
  process.env.SEED_PROJECT_ID?.trim() ||
  process.env.DEV_PROJECT_ID?.trim() ||
  '019f0440-0b9b-74dd-b646-003e7eb7997e';

const OWNER_ID =
  process.env.SEED_OWNER_ID?.trim() ||
  process.env.ADMIN_USER_ID?.trim() ||
  '019f0440-05ba-7cb7-8b20-75c7df4854fc';

const MONGODB_URI = process.env.MONGODB_URI?.trim();
const WIPE = process.env.SEED_DEMO_WIPE === '1';

// Team of assignees for deals/orders/activities. Owner is always first; extra
// ids (real test users) make the team / top-managers charts non-trivial.
const ASSIGNEES: string[] = [
  OWNER_ID,
  ...(process.env.SEED_ASSIGNEE_IDS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
];

const MS_DAY = 86_400_000;
const NOW = Date.now();
const startOfMonth = (() => {
  const d = new Date(NOW);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
})();

// ───────────────────── deterministic ids (idempotency) ─────────────────────

const NS = 'fairflow:demo:v1';
/** Stable ObjectId from a logical key: re-runs upsert the same _id. */
function oid(...parts: (string | number)[]): ObjectId {
  const h = crypto.createHash('md5').update(`${NS}:${PROJECT_ID}:${parts.join(':')}`).digest('hex');
  return new ObjectId(h.slice(0, 24));
}
/** Mark every demo doc so SEED_DEMO_WIPE can find them without touching real data. */
const SEED_TAG = 'demo-seed-v1';

const pick = <T>(arr: T[], i: number): T => arr[i % arr.length];

// ────────────────────────────── reference data ──────────────────────────────

// Pipeline: active stages s1..s6 + won/lost. The `won`/`lost` ids are required
// by the reports won-KPI; `kind` lets the kanban render closed columns.
const PIPELINE_ID = 'demo-pipeline';
const STAGES = [
  { id: 's1', name: 'Обращение', color: '#3b82f6', order: 0, kind: 'active', probability: 10 },
  { id: 's2', name: 'Квалификация', color: '#6366f1', order: 1, kind: 'active', probability: 25 },
  { id: 's3', name: 'КП отправлено', color: '#8b5cf6', order: 2, kind: 'active', probability: 45 },
  { id: 's4', name: 'Переговоры', color: '#eab308', order: 3, kind: 'active', probability: 65 },
  { id: 's5', name: 'Согласование', color: '#f97316', order: 4, kind: 'active', probability: 80 },
  { id: 's6', name: 'Оформление', color: '#06b6d4', order: 5, kind: 'active', probability: 90 },
  { id: 'won', name: 'Сделка', color: '#22c55e', order: 6, kind: 'won', probability: 100 },
  { id: 'lost', name: 'Проиграна', color: '#ef4444', order: 7, kind: 'lost', probability: 0 },
];
const ACTIVE_STAGE_IDS = STAGES.filter((s) => s.kind === 'active').map((s) => s.id);

const SOURCES = [
  { id: 'ds1', name: 'Сайт', color: '#6366f1' },
  { id: 'ds2', name: 'Входящий звонок', color: '#8b5cf6' },
  { id: 'ds3', name: 'Рекомендация', color: '#22c55e' },
  { id: 'ds4', name: 'Выставка', color: '#f97316' },
  { id: 'ds5', name: 'Email-рассылка', color: '#06b6d4' },
  { id: 'ds6', name: 'Партнёр', color: '#eab308' },
];

const LOST_REASONS = [
  { id: 'lr1', name: 'Дорого', order: 0 },
  { id: 'lr2', name: 'Выбрали конкурента', order: 1 },
  { id: 'lr3', name: 'Нет бюджета', order: 2 },
  { id: 'lr4', name: 'Не вовремя', order: 3 },
];

// 14 products across realistic categories with sane RUB prices.
const PRODUCTS = [
  { name: 'CRM Fairflow — лицензия Standard (год)', category: 'Лицензии SaaS', price: 180_000, unit: 'YEAR' },
  { name: 'CRM Fairflow — лицензия Professional (год)', category: 'Лицензии SaaS', price: 360_000, unit: 'YEAR' },
  { name: 'CRM Fairflow — лицензия Enterprise (год)', category: 'Лицензии SaaS', price: 720_000, unit: 'YEAR' },
  { name: 'Дополнительное рабочее место (мес.)', category: 'Лицензии SaaS', price: 1_200, unit: 'MONTH' },
  { name: 'Внедрение «под ключ»', category: 'Услуги внедрения', price: 450_000, unit: 'ONE_TIME' },
  { name: 'Интеграция с 1С', category: 'Услуги внедрения', price: 220_000, unit: 'ONE_TIME' },
  { name: 'Миграция данных', category: 'Услуги внедрения', price: 150_000, unit: 'ONE_TIME' },
  { name: 'Настройка телефонии', category: 'Услуги внедрения', price: 95_000, unit: 'ONE_TIME' },
  { name: 'Обучение команды (1 день)', category: 'Обучение', price: 60_000, unit: 'ONE_TIME' },
  { name: 'Техподдержка Premium (год)', category: 'Поддержка', price: 240_000, unit: 'YEAR' },
  { name: 'Техподдержка Standard (год)', category: 'Поддержка', price: 120_000, unit: 'YEAR' },
  { name: 'Сервер приложений (rack)', category: 'Оборудование', price: 540_000, unit: 'ONE_TIME' },
  { name: 'IP-телефон Yealink T54W', category: 'Оборудование', price: 14_500, unit: 'ONE_TIME' },
  { name: 'Доработка API (час)', category: 'Услуги', price: 4_500, unit: 'HOUR' },
];

const COMPANIES = [
  { name: 'ООО ТехноСофт', inn: '7701234567', industry: 'IT', region: 'Москва', phone: '+7 495 100-10-01', email: 'info@technosoft.ru', website: 'technosoft.ru' },
  { name: 'Ростелеком-Регион', inn: '7702345678', industry: 'Телеком', region: 'Москва', phone: '+7 495 100-10-02', email: 'sales@rt-region.ru', website: 'rt-region.ru' },
  { name: 'ГК Вектор', inn: '7703456789', industry: 'Консалтинг', region: 'Санкт-Петербург', phone: '+7 812 100-10-03', email: 'office@vektor.ru', website: 'vektor-group.ru' },
  { name: 'Альфа-Логистика', inn: '7704567890', industry: 'Логистика', region: 'Москва', phone: '+7 495 100-10-04', email: 'logist@alfa-log.ru', website: 'alfa-log.ru' },
  { name: 'МедТех Системы', inn: '7705678901', industry: 'Медицина', region: 'Казань', phone: '+7 843 100-10-05', email: 'hello@medtech.ru', website: 'medtech-sys.ru' },
  { name: 'СтройИнвест', inn: '7706789012', industry: 'Строительство', region: 'Екатеринбург', phone: '+7 343 100-10-06', email: 'info@stroyinvest.ru', website: 'stroyinvest.ru' },
  { name: 'АгроХолдинг Нива', inn: '7707890123', industry: 'Сельское хозяйство', region: 'Краснодар', phone: '+7 861 100-10-07', email: 'info@niva-agro.ru', website: 'niva-agro.ru' },
  { name: 'Финанс-Групп', inn: '7708901234', industry: 'Финансы', region: 'Москва', phone: '+7 495 100-10-08', email: 'office@finance-group.ru', website: 'finance-group.ru' },
  { name: 'РитейлМаркет', inn: '7709012345', industry: 'Розница', region: 'Новосибирск', phone: '+7 383 100-10-09', email: 'sales@retailmarket.ru', website: 'retailmarket.ru' },
  { name: 'ЭнергоПром', inn: '7710123456', industry: 'Энергетика', region: 'Самара', phone: '+7 846 100-10-10', email: 'info@energoprom.ru', website: 'energoprom.ru' },
];

const FIRST = ['Алексей', 'Мария', 'Дмитрий', 'Екатерина', 'Сергей', 'Ольга', 'Иван', 'Наталья', 'Павел', 'Анна', 'Роман', 'Юлия', 'Андрей', 'Светлана', 'Михаил', 'Татьяна', 'Денис', 'Елена', 'Виктор', 'Оксана', 'Артём', 'Ирина', 'Константин', 'Людмила', 'Николай', 'Галина', 'Владимир', 'Маргарита'];
const LAST = ['Кузнецов', 'Соколова', 'Морозов', 'Лебедева', 'Новиков', 'Волкова', 'Соловьёв', 'Васильева', 'Зайцев', 'Павлова', 'Семёнов', 'Голубева', 'Виноградов', 'Богданова', 'Воробьёв', 'Фёдорова', 'Михайлов', 'Беляева', 'Тарасов', 'Комарова', 'Орлов', 'Киселёва', 'Макаров', 'Андреева', 'Ковалёв', 'Ильина', 'Гусев', 'Титова'];
const POS = ['Генеральный директор', 'Коммерческий директор', 'Менеджер по закупкам', 'ИТ-директор', 'Финансовый директор', 'Руководитель проекта', 'Главный бухгалтер', 'Технический директор', 'Руководитель отдела продаж', 'Системный администратор'];

const DEAL_TOPICS = ['Внедрение CRM', 'Интеграция 1С', 'Лицензии на год', 'Техподдержка Premium', 'Аналитический модуль', 'Миграция данных', 'Обучение команды', 'Доработка API', 'Пилотный проект', 'Расширение лицензий', 'Настройка телефонии', 'Закупка оборудования'];

// Order types (sales types) — fields + processing stages.
const ORDER_TYPES = [
  {
    id: 'ot-license', name: 'Продажа лицензий',
    fields: [
      { key: 'seats', label: 'Кол-во рабочих мест', type: 'NUMBER', required: true, options: [] },
      { key: 'note', label: 'Комментарий', type: 'TEXT', required: false, options: [] },
    ],
    stages: ['Оформление', 'Оплата', 'Активация', 'Завершена'],
  },
  {
    id: 'ot-implementation', name: 'Внедрение',
    fields: [
      { key: 'scope', label: 'Объём работ', type: 'TEXT', required: false, options: [] },
      { key: 'note', label: 'Комментарий', type: 'TEXT', required: false, options: [] },
    ],
    stages: ['Договор', 'Аванс', 'Реализация', 'Сдача', 'Завершена'],
  },
  {
    id: 'ot-equipment', name: 'Поставка оборудования',
    fields: [
      { key: 'qty', label: 'Количество', type: 'NUMBER', required: true, options: [] },
      { key: 'note', label: 'Комментарий', type: 'TEXT', required: false, options: [] },
    ],
    stages: ['Заказ', 'Оплата', 'Поставка', 'Завершена'],
  },
];

const ACT_TYPES = ['call', 'meeting', 'task'];
const ACT_TITLES = [
  'Первичный звонок клиенту', 'Уточнить требования', 'Подготовить КП',
  'Демонстрация системы', 'Согласовать договор', 'Перезвонить по итогам встречи',
  'Отправить коммерческое предложение', 'Контрольный звонок', 'Встреча с ЛПР',
  'Обсудить условия оплаты', 'Напомнить об оплате', 'Финальная презентация',
];

// ───────────────────────────── helpers ─────────────────────────────

function digitsPhone(i: number): string {
  const a = 900 + (i % 99);
  const b = 100 + (i * 7) % 899;
  const c = 10 + (i * 13) % 89;
  const d = 10 + (i * 17) % 89;
  return `+7 ${a} ${b}-${c}-${d}`;
}
function normPhone(p: string): string {
  return p.replace(/[^\d+]/g, '');
}
function normEmail(e: string): string {
  return e.trim().toLowerCase();
}
function translit(s: string): string {
  const map: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return s.toLowerCase().split('').map((c) => map[c] ?? c).join('');
}

async function upsert(db: Db, coll: string, _id: ObjectId, doc: Record<string, unknown>) {
  await db.collection(coll).updateOne(
    { _id },
    { $set: { ...doc, _id, seedTag: SEED_TAG } },
    { upsert: true },
  );
}

// ───────────────────────────── main ─────────────────────────────

interface SeededDeal {
  _id: ObjectId; idx: number; companyId: ObjectId; contactId: ObjectId; productId: ObjectId;
  productName: string; assigneeId: string; source: string; amount: number; createdAt: number;
  status: 'open' | 'won' | 'lost'; stageId: string; wonAt: number; lostAt: number; name: string; topic: string;
}

async function main() {
  if (!MONGODB_URI) {
    console.error('MONGODB_URI is required (set it in env or backend/.fairflow-dev.env / .env)');
    process.exit(1);
  }
  console.log(`[seed-demo] project=${PROJECT_ID} owner=${OWNER_ID} assignees=${ASSIGNEES.length} wipe=${WIPE}`);

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();

  if (WIPE) {
    const cols = ['crm_products', 'companies', 'contacts', 'crm_deals', 'crm_orders', 'crm_activities', 'crm_deal_stage_history', 'audit_events', 'crm_pipelines', 'crm_deal_sources', 'crm_lost_reasons', 'crm_order_types', 'crm_order_type_revisions'];
    for (const c of cols) {
      const r = await db.collection(c).deleteMany({ projectId: PROJECT_ID, seedTag: SEED_TAG });
      if (r.deletedCount) console.log(`  wiped ${r.deletedCount} from ${c}`);
    }
  }

  // ── 1) pipeline + sources + lost reasons ──────────────────────────────────
  // Reuse the project's existing default pipeline id if one already exists, so
  // deals land on the board the user actually sees. Otherwise create the demo one.
  const existingDefault = await db.collection('crm_pipelines').findOne({ projectId: PROJECT_ID, isDefault: true });
  const pipelineId = existingDefault?.id ? String(existingDefault.id) : PIPELINE_ID;
  // Merge our stages into the pipeline, guaranteeing won/lost stages exist
  // (won-KPI needs stageId 'won'). Keep existing active stages if present.
  const existingStages = (existingDefault?.stages as { id: string; name: string }[] | undefined) ?? [];
  const mergedStages = (() => {
    if (existingStages.length) {
      const ids = new Set(existingStages.map((s) => s.id));
      const extra = STAGES.filter((s) => (s.kind === 'won' || s.kind === 'lost') && !ids.has(s.id));
      return [...existingStages, ...extra.map((s) => ({ id: s.id, name: s.name, color: s.color, order: s.order, kind: s.kind, probability: s.probability }))];
    }
    return STAGES;
  })();
  const activeStageIds = existingStages.length
    ? existingStages.filter((s) => !['won', 'lost'].includes(s.id)).map((s) => s.id)
    : ACTIVE_STAGE_IDS;
  await upsert(db, 'crm_pipelines', existingDefault?._id ?? oid('pipeline'), {
    id: pipelineId, projectId: PROJECT_ID, name: existingDefault?.name ?? 'Продажи', isDefault: true, stages: mergedStages,
  });
  for (const s of SOURCES) {
    await upsert(db, 'crm_deal_sources', oid('source', s.id), { id: s.id, projectId: PROJECT_ID, name: s.name, color: s.color });
  }
  for (const lr of LOST_REASONS) {
    await upsert(db, 'crm_lost_reasons', oid('lost-reason', lr.id), { id: lr.id, projectId: PROJECT_ID, name: lr.name, order: lr.order, active: true });
  }
  console.log(`[seed-demo] pipeline=${pipelineId} stages=${mergedStages.length} sources=${SOURCES.length} lostReasons=${LOST_REASONS.length}`);

  // ── 2) products ───────────────────────────────────────────────────────────
  const productIds: ObjectId[] = [];
  for (let i = 0; i < PRODUCTS.length; i++) {
    const p = PRODUCTS[i];
    const _id = oid('product', i);
    productIds.push(_id);
    await upsert(db, 'crm_products', _id, {
      projectId: PROJECT_ID, name: p.name, description: `${p.category}. Демонстрационная позиция каталога.`,
      category: p.category, price: p.price, effectivePrice: p.price, currency: 'RUB', unit: p.unit,
      orderTypeId: '', orderTypeName: '', orderTypeDangling: false, prefill: {}, status: 'active',
      archivedAt: null, ownerDepartmentId: null, dealsCount: 0, activeDealsCount: 0, ordersCount: 0,
      createdAt: NOW - 200 * MS_DAY, updatedAt: NOW,
    });
  }
  console.log(`[seed-demo] products=${productIds.length}`);

  // ── 3) companies ──────────────────────────────────────────────────────────
  const companyIds: ObjectId[] = [];
  for (let i = 0; i < COMPANIES.length; i++) {
    const c = COMPANIES[i];
    const _id = oid('company', i);
    companyIds.push(_id);
    const created = new Date(NOW - (180 - i * 6) * MS_DAY);
    await upsert(db, 'companies', _id, {
      projectId: PROJECT_ID, name: c.name, inn: c.inn, kpp: `${c.inn.slice(0, 4)}01001`,
      legalAddress: `${c.region}, ул. Центральная, д. ${10 + i}`, phone: c.phone, email: c.email,
      industry: c.industry, region: c.region, website: c.website, domain: c.website,
      status: i % 3 === 0 ? 'client' : i % 3 === 1 ? 'lead' : 'partner',
      ownerId: pick(ASSIGNEES, i), source: 'manual', tags: [c.industry], notes: '',
      createdBy: OWNER_ID, updatedBy: OWNER_ID, deletedAt: null, createdAt: created, updatedAt: created,
    });
  }
  console.log(`[seed-demo] companies=${companyIds.length}`);

  // ── 4) contacts (≈28, attached to companies) ──────────────────────────────
  const CONTACT_COUNT = 28;
  const contacts: { _id: ObjectId; companyId: ObjectId; name: string; phone: string; email: string }[] = [];
  for (let i = 0; i < CONTACT_COUNT; i++) {
    const _id = oid('contact', i);
    const companyId = companyIds[i % companyIds.length];
    const company = COMPANIES[i % companyIds.length];
    const first = pick(FIRST, i);
    const last = pick(LAST, i);
    const phone = digitsPhone(i);
    const emailDomain = company.website || 'example.ru';
    const email = `${translit(last)}.${translit(first[0])}@${emailDomain}`;
    const created = new Date(NOW - (170 - i * 5) * MS_DAY);
    contacts.push({ _id, companyId, name: `${first} ${last}`, phone, email });
    await upsert(db, 'contacts', _id, {
      projectId: PROJECT_ID, firstName: first, lastName: last, middleName: '',
      phone, email, phoneNormalized: normPhone(phone), emailNormalized: normEmail(email),
      position: pick(POS, i), companyIds: [companyId.toString()],
      source: pick(SOURCES, i).name, ownerId: pick(ASSIGNEES, i), departmentId: null,
      tags: [], notes: '', mergedInto: null, deletedAt: null, createdAt: created, updatedAt: created,
    });
  }
  console.log(`[seed-demo] contacts=${contacts.length}`);

  // ── 5) order types (sales types) + v1 revisions ───────────────────────────
  for (const ot of ORDER_TYPES) {
    const stages = ot.stages.map((name, order) => ({
      id: `os${order + 1}`, name, order, requiredFieldKeys: [], isTerminal: order === ot.stages.length - 1,
    }));
    const _id = oid('order-type', ot.id);
    await upsert(db, 'crm_order_types', _id, {
      id: ot.id, projectId: PROJECT_ID, name: ot.name, description: 'Демонстрационный тип продажи.',
      currentVersion: 1, deletedAt: null, schemaVersion: 1, webhookEnabled: false,
      fields: ot.fields, stages, createdAt: NOW - 190 * MS_DAY, updatedAt: NOW,
    });
    await upsert(db, 'crm_order_type_revisions', oid('order-type-rev', ot.id, 1), {
      id: `${ot.id}-rev1`, projectId: PROJECT_ID, orderTypeId: ot.id, version: 1, status: 'PUBLISHED',
      fields: ot.fields, stages, finalActionSpec: { type: 'none', config: {} },
      retryPolicy: { maxAttempts: 3, strategy: 'exponential', baseIntervalSec: 30, maxWaitSec: 3600 },
      documentTemplates: [], terminalStageId: stages[stages.length - 1].id,
      createdAt: NOW - 190 * MS_DAY, updatedAt: NOW,
    });
  }
  console.log(`[seed-demo] orderTypes=${ORDER_TYPES.length}`);

  // ── 6) deals (50) — spread over 6 months + current month; staged; won/lost ──
  // Distribution of the 50 deals across outcome/stage. Open deals weighted toward
  // earlier stages (funnel shape); plus a healthy won/lost set for conversion.
  const DEAL_COUNT = 50;
  // outcome plan: ~22 won, ~10 lost, ~18 open across active stages.
  const stagePlan: { status: 'open' | 'won' | 'lost'; stageId: string }[] = [];
  for (let i = 0; i < DEAL_COUNT; i++) {
    const r = i % 10;
    if (r < 4) stagePlan.push({ status: 'won', stageId: 'won' });          // 40% won
    else if (r < 6) stagePlan.push({ status: 'lost', stageId: 'lost' });   // 20% lost
    else stagePlan.push({ status: 'open', stageId: pick(activeStageIds, i) }); // 40% open, varied stages
  }

  const deals: SeededDeal[] = [];
  for (let i = 0; i < DEAL_COUNT; i++) {
    const _id = oid('deal', i);
    const plan = stagePlan[i];
    const companyId = companyIds[i % companyIds.length];
    // contact belonging to the same company where possible.
    const contact = contacts.find((c) => c.companyId.equals(companyId)) ?? contacts[i % contacts.length];
    const productIdx = i % PRODUCTS.length;
    const productId = productIds[productIdx];
    const product = PRODUCTS[productIdx];
    const assigneeId = pick(ASSIGNEES, i);
    const source = pick(SOURCES, i).name;
    const topic = pick(DEAL_TOPICS, i);
    const company = COMPANIES[i % companyIds.length];
    // Amount: product price × 1..3, rounded; gives spread for sums/avg-check.
    const amount = product.price * (1 + (i % 3));
    // createdAt spread: deals 0..(DEAL_COUNT-13) over ~6 months, last 13 in current month.
    let createdAt: number;
    if (i < DEAL_COUNT - 13) {
      createdAt = NOW - Math.round((180 * (DEAL_COUNT - 13 - i)) / (DEAL_COUNT - 13)) * MS_DAY;
    } else {
      // current month: spread across the month so the default `month` dashboard is full.
      const k = i - (DEAL_COUNT - 13);
      createdAt = startOfMonth + Math.min(NOW - startOfMonth - MS_DAY, k * 2 * MS_DAY + MS_DAY);
    }
    const wonAt = plan.status === 'won' ? Math.min(NOW, createdAt + (5 + (i % 25)) * MS_DAY) : 0;
    const lostAt = plan.status === 'lost' ? Math.min(NOW, createdAt + (3 + (i % 20)) * MS_DAY) : 0;
    const closedAt = wonAt || lostAt || 0;
    const name = `${topic} — ${company.name}`;

    // stageLog: realistic progression up to the current/closed stage.
    const stageLog: { stageId: string; enteredAt: number; exitedAt?: number; movedBy: string; kind: string }[] = [];
    const targetStageId = plan.stageId;
    const targetIdx = plan.status === 'open'
      ? activeStageIds.indexOf(targetStageId)
      : activeStageIds.length - 1; // closed deals walked the full active path
    const span = (closedAt || NOW) - createdAt;
    for (let s = 0; s <= Math.max(0, targetIdx); s++) {
      const enteredAt = createdAt + Math.round((span * s) / (Math.max(1, targetIdx + (plan.status === 'open' ? 0 : 1))));
      stageLog.push({ stageId: activeStageIds[s], enteredAt, movedBy: assigneeId, kind: s === 0 ? 'create' : 'move' });
    }
    if (plan.status !== 'open') {
      stageLog.push({ stageId: targetStageId, enteredAt: closedAt || NOW, movedBy: assigneeId, kind: 'move' });
    }
    // close the exitedAt for all but the last entry.
    for (let s = 0; s < stageLog.length - 1; s++) stageLog[s].exitedAt = stageLog[s + 1].enteredAt;

    const lostReasonId = plan.status === 'lost' ? pick(LOST_REASONS, i).id : '';

    deals.push({
      _id, idx: i, companyId, contactId: contact._id, productId, productName: product.name,
      assigneeId, source, amount, createdAt, status: plan.status, stageId: targetStageId, wonAt, lostAt, name, topic,
    });

    await upsert(db, 'crm_deals', _id, {
      projectId: PROJECT_ID, pipelineId, stageId: targetStageId, name, amount, currency: 'RUB',
      contactId: contact._id.toString(), companyId: companyId.toString(),
      productId: productId.toString(), productName: product.name,
      assigneeId, departmentId: '', source,
      status: plan.status, probability: STAGES.find((s) => s.id === targetStageId)?.probability ?? 0,
      expectedCloseDate: createdAt + 30 * MS_DAY,
      wonAt: wonAt || undefined, lostAt: lostAt || undefined, closedAt: closedAt || undefined,
      wonVersion: plan.status === 'won' ? 1 : undefined,
      lostReasonId: lostReasonId || undefined,
      lostReasonComment: plan.status === 'lost' ? 'Демо: причина проигрыша' : undefined,
      result: plan.status === 'won' ? 'won' : plan.status === 'lost' ? 'lost' : '',
      lightName: '', lightPhone: '', lightEmail: '', lightCompanyName: '',
      tags: [topic], stageLog,
      createdAt, updatedAt: closedAt || NOW, stageEnteredAt: stageLog[stageLog.length - 1].enteredAt,
      deletedAt: null,
    });

    // stage history rows (dedicated collection) — one per transition.
    for (let s = 0; s < stageLog.length; s++) {
      const e = stageLog[s];
      await upsert(db, 'crm_deal_stage_history', oid('stage-history', i, s), {
        projectId: PROJECT_ID, dealId: _id.toString(), pipelineId,
        fromStageId: s === 0 ? '' : stageLog[s - 1].stageId, toStageId: e.stageId,
        enteredAt: e.enteredAt, movedBy: e.movedBy, kind: e.kind, createdAt: e.enteredAt,
      });
    }
  }
  const wonDeals = deals.filter((d) => d.status === 'won');
  const lostDeals = deals.filter((d) => d.status === 'lost');
  const openDeals = deals.filter((d) => d.status === 'open');
  console.log(`[seed-demo] deals=${deals.length} (won=${wonDeals.length} lost=${lostDeals.length} open=${openDeals.length})`);

  // ── 7) orders (sales) on won deals + products + order types ────────────────
  // ~24 orders: every won deal becomes one order, plus a few extra on open deals.
  const orderSourceDeals = [...wonDeals, ...openDeals.slice(0, Math.max(0, 24 - wonDeals.length))].slice(0, 24);
  let orderCount = 0;
  for (let i = 0; i < orderSourceDeals.length; i++) {
    const d = orderSourceDeals[i];
    const _id = oid('order', i);
    const ot = ORDER_TYPES[i % ORDER_TYPES.length];
    const stages = ot.stages;
    // active orders progress through stages; a couple are cancelled.
    const isCancelled = i % 11 === 10;
    const stageIdx = isCancelled ? 0 : (d.status === 'won' ? stages.length - 1 : i % stages.length);
    const stageId = `os${stageIdx + 1}`;
    const createdAt = (d.wonAt || d.createdAt) + 2 * MS_DAY;
    const fields = ot.fields.reduce<Record<string, unknown>>((acc, f) => {
      if (f.key === 'seats') acc[f.key] = 5 + (i % 20);
      else if (f.key === 'qty') acc[f.key] = 1 + (i % 5);
      else if (f.key === 'scope') acc[f.key] = 'Полное внедрение модулей CRM';
      else acc[f.key] = 'Демо-продажа';
      return acc;
    }, {});
    await upsert(db, 'crm_orders', _id, {
      projectId: PROJECT_ID, typeId: ot.id, orderTypeVersion: 1, number: `ORD-${1000 + i}`,
      dealId: d._id.toString(), dealName: d.name,
      contactId: d.contactId.toString(), companyId: d.companyId.toString(),
      productId: d.productId.toString(), productName: d.productName,
      assigneeId: d.assigneeId, stageId, stageChangedAt: createdAt,
      snapshot: { contact: {}, company: {}, capturedAt: createdAt, contactSourceHash: '', companySourceHash: '' },
      fieldsJson: JSON.stringify(fields),
      status: isCancelled ? 'CANCELLED' : 'ACTIVE', cancelReason: isCancelled ? 'Демо: отказ клиента' : '',
      hasDrift: false, finalActionState: { status: 'IDLE', payloadGen: 1, attempts: [] },
      amount: d.amount, currency: 'RUB',
      createdAt, updatedAt: createdAt, createdBy: d.assigneeId,
    });
    orderCount++;
  }
  console.log(`[seed-demo] orders=${orderCount}`);

  // ── 8) activities (≈45) — calls/meetings/tasks, overdue/done/upcoming ──────
  const ACT_COUNT = 45;
  let actCount = 0;
  for (let i = 0; i < ACT_COUNT; i++) {
    const _id = oid('activity', i);
    const d = deals[i % deals.length];
    const type = pick(ACT_TYPES, i);
    const assigneeId = d.assigneeId;
    // due distribution: ~1/3 overdue (past, planned), ~1/3 done (past), ~1/3 upcoming.
    const bucket = i % 3;
    let dueAt: number;
    let actStatus: string;
    let completedAt: number | null = null;
    if (bucket === 0) { dueAt = NOW - (1 + (i % 10)) * MS_DAY; actStatus = 'planned'; }       // overdue
    else if (bucket === 1) { dueAt = NOW - (1 + (i % 14)) * MS_DAY; actStatus = 'completed'; completedAt = dueAt + 3600_000; } // done
    else { dueAt = NOW + (1 + (i % 7)) * MS_DAY; actStatus = 'planned'; }                       // upcoming
    const title = pick(ACT_TITLES, i);
    const createdAt = Math.min(dueAt, NOW) - 2 * MS_DAY;
    const contact = contacts.find((c) => c._id.equals(d.contactId));
    const links = [
      { entityType: 'deal', entityId: d._id.toString(), nameSnapshot: d.name, orphaned: false },
      { entityType: 'contact', entityId: d.contactId.toString(), nameSnapshot: contact?.name ?? '', orphaned: false },
      { entityType: 'company', entityId: d.companyId.toString(), nameSnapshot: '', orphaned: false },
    ];
    await upsert(db, 'crm_activities', _id, {
      projectId: PROJECT_ID, type, title, description: 'Демонстрационная активность.',
      status: actStatus, priority: pick(['low', 'medium', 'high'], i),
      // pipe/activity domain spelling:
      dueDate: dueAt, startDate: type === 'meeting' ? dueAt : null, endDate: type === 'meeting' ? dueAt + 3600_000 : null,
      allDay: false, direction: type === 'call' ? (i % 2 ? 'outbound' : 'inbound') : '',
      duration: type === 'meeting' ? 60 : null, actualDuration: null,
      location: type === 'meeting' ? 'Офис клиента' : '', participants: [],
      assigneeId, createdBy: assigneeId,
      // reports/statistics dashboard spelling (dueAt + ownerId):
      dueAt, ownerId: assigneeId,
      links, result: '', reminderOffset: 'none', reminderFireAt: null, reminderState: 'none',
      completedAt, deletedAt: null, createdAt, updatedAt: NOW,
    });
    actCount++;
  }
  console.log(`[seed-demo] activities=${actCount}`);

  // ── 9) audit history (appendEvent/toRow shape) — what /audit/events returns ──
  // One+ rows per deal (created / stage moves / won|lost) and per order (created).
  let auditCount = 0;
  const auditRow = async (ns: string, seq: number, when: number, deal: SeededDeal, eventName: string, entityType: string, entityId: string, payload: Record<string, unknown>) => {
    await upsert(db, 'audit_events', oid('audit', ns, seq), {
      projectId: PROJECT_ID, eventName, entityType, entityId,
      actorId: deal.assigneeId, actorType: 'user',
      payloadJson: JSON.stringify(payload), requestId: '', traceId: '',
      createdAt: when,
    });
    auditCount++;
  };
  for (const d of deals) {
    let seq = 0;
    await auditRow(`deal:${d.idx}`, seq++, d.createdAt, d, 'crm.deal.created', 'deal', d._id.toString(), { name: d.name, amount: d.amount, source: d.source, stageId: activeStageIds[0] });
    // a couple of stage moves
    const moveAt1 = d.createdAt + 3 * MS_DAY;
    await auditRow(`deal:${d.idx}`, seq++, moveAt1, d, 'crm.deal.stage_changed', 'deal', d._id.toString(), { from: activeStageIds[0], to: activeStageIds[Math.min(1, activeStageIds.length - 1)] });
    if (d.status === 'won') {
      await auditRow(`deal:${d.idx}`, seq++, d.wonAt, d, 'crm.deal.won', 'deal', d._id.toString(), { amount: d.amount, wonAt: d.wonAt });
    } else if (d.status === 'lost') {
      await auditRow(`deal:${d.idx}`, seq++, d.lostAt, d, 'crm.deal.lost', 'deal', d._id.toString(), { lostAt: d.lostAt, reason: 'lr' });
    }
  }
  for (let i = 0; i < orderSourceDeals.length; i++) {
    const d = orderSourceDeals[i];
    const orderId = oid('order', i).toString();
    await auditRow(`order:${i}`, 0, (d.wonAt || d.createdAt) + 2 * MS_DAY, d, 'crm.order.created', 'order', orderId, { number: `ORD-${1000 + i}`, dealId: d._id.toString() });
  }
  console.log(`[seed-demo] auditEvents=${auditCount}`);

  // ── 10) denormalized counters on products (deals/orders per product) ───────
  for (let p = 0; p < productIds.length; p++) {
    const pid = productIds[p].toString();
    const linkedDeals = deals.filter((d) => d.productId.toString() === pid);
    const activeLinked = linkedDeals.filter((d) => d.status === 'open');
    const linkedOrders = orderSourceDeals.filter((d) => d.productId.toString() === pid);
    await db.collection('crm_products').updateOne(
      { _id: productIds[p] },
      { $set: { dealsCount: linkedDeals.length, activeDealsCount: activeLinked.length, ordersCount: linkedOrders.length } },
    );
  }

  await client.close();
  console.log('[seed-demo] DONE');
}

main().catch((e) => {
  console.error('[seed-demo] FATAL', e);
  process.exit(1);
});
