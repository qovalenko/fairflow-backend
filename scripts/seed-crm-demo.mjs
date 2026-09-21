#!/usr/bin/env node
/**
 * Demo CRM seed for a Fairflow stand — populates a project with realistic
 * companies / contacts / deals (across pipeline stages) / activities via the
 * PUBLIC gateway API (no direct DB access).
 *
 * Idempotency: additive by default. Set SEED_RESET=1 to delete existing
 * deals/contacts/companies in the project first (activities have no delete API).
 *
 * Usage:
 *   NODE_EXTRA_CA_CERTS=/path/to/ff-ca.crt \
 *   FF_BASE=http://localhost:3000 FF_EMAIL=admin@fairflow.local FF_PASSWORD=admin \
 *   node scripts/seed-crm-demo.mjs
 *
 * Env:
 *   FF_BASE            gateway base url (default http://localhost:3000)
 *   FF_EMAIL/FF_PASSWORD  login (default admin@fairflow.local / admin)
 *   FF_PROJECT_ID      target project (default: first project of the user)
 *   NODE_EXTRA_CA_CERTS  CA bundle when the stand uses an internal CA
 *   SEED_RESET=1       wipe project deals/contacts/companies before seeding
 *
 * Notes:
 *   - project id and the default pipeline (+ its stage ids) are resolved at
 *     runtime — nothing is hardcoded, so the seed lands in the project the UI
 *     actually uses and deal stages resolve to names.
 */

const BASE = process.env.FF_BASE || 'http://localhost:3000';
const EMAIL = process.env.FF_EMAIL || 'admin@fairflow.local';
const PASSWORD = process.env.FF_PASSWORD || 'admin';
const RESET = process.env.SEED_RESET === '1';

let TOKEN = '';
let PID = process.env.FF_PROJECT_ID || '';
const H = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'x-project-id': PID });
const q = (p) => `${BASE}${p}${p.includes('?') ? '&' : '?'}projectId=${PID}`;

async function req(method, path, body) {
  const r = await fetch(q(path), { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) { console.log(`  ${method} ${path} FAIL [${r.status}] ${t.slice(0, 140)}`); return null; }
  try { return JSON.parse(t); } catch { return {}; }
}
const post = (p, b) => req('POST', p, b);
const del = (p) => req('DELETE', p);

async function login() {
  const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login failed [${r.status}]`);
  const d = await r.json();
  TOKEN = d.token;
  return d.user?.userId || d.user?.id;
}

async function resolveProject(userId) {
  if (PID) return PID;
  const r = await fetch(`${BASE}/api/v1/projects?userId=${userId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const list = await r.json();
  if (!Array.isArray(list) || !list.length) throw new Error('no projects for user — create one in the UI first');
  PID = list[0].id;
  return PID;
}

async function resolvePipeline() {
  const r = await fetch(q('/api/v1/pipelines'), { headers: H() });
  const list = await r.json();
  const pl = (Array.isArray(list) ? list : []).find((p) => p.isDefault) || list[0];
  if (!pl) throw new Error('no pipeline in project');
  return { id: pl.id, stages: (pl.stages || []).map((s) => s.id) };
}

async function reset() {
  console.log('\n== reset (deals/contacts/companies) ==');
  for (const p of ['/api/v1/deals', '/api/v1/contacts', '/api/v1/companies']) {
    const r = await fetch(q(`${p}?pageSize=500`), { headers: H() });
    const d = await r.json();
    const items = Array.isArray(d) ? d : (d.list || []);
    let n = 0;
    for (const it of items) if (it.id && (await del(`${p}/${it.id}`))) n++;
    console.log(`  ${p}: deleted ${n}/${items.length}`);
  }
}

const COMPANIES = [
  { name: 'ООО ТехноСофт', inn: '7701234567', phone: '+7 495 100-10-01', email: 'info@technosoft.ru', industry: 'IT' },
  { name: 'Ростелеком-Регион', inn: '7702345678', phone: '+7 495 100-10-02', email: 'sales@rt-region.ru', industry: 'Телеком' },
  { name: 'ГК Вектор', inn: '7703456789', phone: '+7 495 100-10-03', email: 'office@vektor.ru', industry: 'Консалтинг' },
  { name: 'Альфа-Логистика', inn: '7704567890', phone: '+7 495 100-10-04', email: 'logist@alfa-log.ru', industry: 'Логистика' },
  { name: 'МедТех Системы', inn: '7705678901', phone: '+7 495 100-10-05', email: 'hello@medtech.ru', industry: 'Медицина' },
  { name: 'СтройИнвест', inn: '7706789012', phone: '+7 495 100-10-06', email: 'info@stroyinvest.ru', industry: 'Строительство' },
];
const FIRST = ['Алексей', 'Мария', 'Дмитрий', 'Екатерина', 'Сергей', 'Ольга', 'Иван', 'Наталья', 'Павел', 'Анна', 'Роман', 'Юлия'];
const LAST = ['Кузнецов', 'Соколова', 'Морозов', 'Лебедева', 'Новиков', 'Волкова', 'Соловьёв', 'Васильева', 'Зайцев', 'Павлова', 'Семёнов', 'Голубева'];
const POS = ['Генеральный директор', 'Коммерческий директор', 'Менеджер по закупкам', 'ИТ-директор', 'Финансовый директор', 'Руководитель проекта'];
const SOURCES = ['Сайт', 'Звонок', 'Реферал', 'Выставка', 'Email-рассылка', 'Партнёр'];
const DEAL_NAMES = ['Внедрение CRM', 'Интеграция 1С', 'Лицензии на год', 'Техподдержка Premium', 'Аналитический модуль', 'Миграция данных', 'Обучение команды', 'Доработка API', 'Пилотный проект', 'Расширение лицензий'];
const ATYPES = ['task', 'call', 'meeting', 'note'];
const PRIOS = ['low', 'medium', 'high'];
const ATITLES = ['Связаться с клиентом', 'Подготовить КП', 'Демо-встреча', 'Согласовать договор', 'Перезвонить', 'Отправить материалы'];
const pick = (arr, i) => arr[i % arr.length];

async function main() {
  const userId = await login();
  await resolveProject(userId);
  const pipe = await resolvePipeline();
  const stageFor = (i) => pipe.stages[[0, 0, 1, 1, 1, 2, 2, 3, 0, 1][i % 10]] ?? pipe.stages[0];
  console.log(`base=${BASE} project=${PID} pipeline=${pipe.id} stages=${pipe.stages.join(',')}`);
  if (RESET) await reset();

  console.log('\n== companies ==');
  const companies = [];
  for (const c of COMPANIES) { const r = await post('/api/v1/companies', c); if (r?.id) { companies.push({ id: r.id, name: c.name }); console.log('  +', c.name); } }

  console.log('\n== contacts ==');
  const contacts = [];
  for (let i = 0; i < 12; i++) {
    const co = companies[i % Math.max(companies.length, 1)];
    const r = await post('/api/v1/contacts', { firstName: pick(FIRST, i), lastName: pick(LAST, i), phone: `+7 916 ${200 + i}-${10 + i}-${(i * 7) % 90 + 10}`, email: `${pick(LAST, i).toLowerCase()}${i}@example.ru`, position: pick(POS, i), companyId: co?.id, source: pick(SOURCES, i) });
    if (r?.id) { contacts.push({ id: r.id, companyId: co?.id }); console.log('  +', pick(FIRST, i), pick(LAST, i)); }
  }

  console.log('\n== deals ==');
  const deals = [];
  for (let i = 0; i < 10; i++) {
    const co = companies[i % Math.max(companies.length, 1)];
    const ct = contacts[i % Math.max(contacts.length, 1)];
    const r = await post('/api/v1/deals', { name: `${pick(DEAL_NAMES, i)} — ${co?.name ?? ''}`.trim(), amount: (i + 1) * 150000 + (i % 3) * 50000, currency: 'RUB', pipelineId: pipe.id, stageId: stageFor(i), companyId: co?.id, contactId: ct?.id, source: pick(SOURCES, i) });
    if (r?.id) { deals.push({ id: r.id, companyId: co?.id, contactId: ct?.id }); console.log('  +', `${pick(DEAL_NAMES, i)} — ${co?.name}`, `[${stageFor(i)}]`); }
  }

  console.log('\n== activities ==');
  const now = Math.floor(Date.now() / 1000);
  let made = 0;
  for (let i = 0; i < 9; i++) {
    const d = deals[i % Math.max(deals.length, 1)];
    const r = await post('/api/v1/activities', { type: pick(ATYPES, i), title: pick(ATITLES, i), description: 'Демо-активность (seed)', status: i % 3 === 0 ? 'done' : 'planned', priority: pick(PRIOS, i), dueDate: now + (i - 3) * 86400, contactId: d?.contactId, companyId: d?.companyId, dealId: d?.id });
    if (r) { made++; console.log('  +', pick(ATYPES, i), pick(ATITLES, i)); }
  }

  console.log(`\nDONE: companies=${companies.length} contacts=${contacts.length} deals=${deals.length} activities=${made}`);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
