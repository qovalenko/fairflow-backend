import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { MongoService } from '../mongo/mongo.service';

/**
 * Онлайн демо-наполнение проекта (вызывается из control'а после ProvisionDefaults,
 * когда при создании проекта установлен seed_demo_data). Порт оффлайн-скрипта
 * `backend/scripts/seed-demo.ts` в сервис: pipe владеет общим CRM-Mongo
 * (`mongo.getDb()` — та же БД, где живут companies/contacts/crm_products/
 * crm_orders/crm_activities/audit_events), поэтому раскладывает СВЯЗНЫЙ набор
 * демо-сущностей в одном месте.
 *
 * Гейтинг по включённым модулям проекта (enabled_modules):
 *   - сделки/воронка/источники/история (audit) — ВСЕГДА (deals — locked-модуль);
 *   - компании / контакты / продукты / продажи / активности — только если
 *     соответствующий модуль включён. Кросс-ссылки сделок/активностей ставятся
 *     лишь на реально созданные (включённые) сущности; иначе — «light»-поля
 *     (имя/телефон/компания строкой), чтобы карточки оставались осмысленными.
 *
 * Пишет НАПРЯМУЮ в Mongo (как и оффлайн-сид и сами дашборды, которые читают
 * коллекции, а не шину). Идемпотентно: каждый документ получает детерминированный
 * `_id` (md5(namespace:projectId:key) → ObjectId), повторный вызов делает upsert
 * на месте. Данные демонстрационные, без чувствительной информации.
 */

const NS = 'fairflow:demo:v1';
const SEED_TAG = 'demo-seed-v1';
const MS_DAY = 86_400_000;

const pick = <T>(arr: T[], i: number): T => arr[i % arr.length];

// ─────────────────────────── reference data ───────────────────────────

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

const PRODUCTS = [
  {
    name: 'CRM Fairflow — лицензия Standard (год)',
    category: 'Лицензии SaaS',
    price: 180_000,
    unit: 'YEAR',
  },
  {
    name: 'CRM Fairflow — лицензия Professional (год)',
    category: 'Лицензии SaaS',
    price: 360_000,
    unit: 'YEAR',
  },
  {
    name: 'CRM Fairflow — лицензия Enterprise (год)',
    category: 'Лицензии SaaS',
    price: 720_000,
    unit: 'YEAR',
  },
  {
    name: 'Дополнительное рабочее место (мес.)',
    category: 'Лицензии SaaS',
    price: 1_200,
    unit: 'MONTH',
  },
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

// Полностью вымышленные демо-компании (без реальных ИНН/брендов).
const COMPANIES = [
  {
    name: 'ООО ТехноСофт',
    inn: '7701234567',
    industry: 'IT',
    region: 'Москва',
    phone: '+7 495 100-10-01',
    email: 'info@technosoft.example',
    website: 'technosoft.example',
  },
  {
    name: 'ООО СвязьРегион',
    inn: '7702345678',
    industry: 'Телеком',
    region: 'Москва',
    phone: '+7 495 100-10-02',
    email: 'sales@svyazregion.example',
    website: 'svyazregion.example',
  },
  {
    name: 'ГК Вектор',
    inn: '7703456789',
    industry: 'Консалтинг',
    region: 'Санкт-Петербург',
    phone: '+7 812 100-10-03',
    email: 'office@vektor.example',
    website: 'vektor-group.example',
  },
  {
    name: 'Альфа-Логистика',
    inn: '7704567890',
    industry: 'Логистика',
    region: 'Москва',
    phone: '+7 495 100-10-04',
    email: 'logist@alfa-log.example',
    website: 'alfa-log.example',
  },
  {
    name: 'МедТех Системы',
    inn: '7705678901',
    industry: 'Медицина',
    region: 'Казань',
    phone: '+7 843 100-10-05',
    email: 'hello@medtech.example',
    website: 'medtech-sys.example',
  },
  {
    name: 'СтройИнвест',
    inn: '7706789012',
    industry: 'Строительство',
    region: 'Екатеринбург',
    phone: '+7 343 100-10-06',
    email: 'info@stroyinvest.example',
    website: 'stroyinvest.example',
  },
  {
    name: 'АгроХолдинг Нива',
    inn: '7707890123',
    industry: 'Сельское хозяйство',
    region: 'Краснодар',
    phone: '+7 861 100-10-07',
    email: 'info@niva-agro.example',
    website: 'niva-agro.example',
  },
  {
    name: 'Финанс-Групп',
    inn: '7708901234',
    industry: 'Финансы',
    region: 'Москва',
    phone: '+7 495 100-10-08',
    email: 'office@finance-group.example',
    website: 'finance-group.example',
  },
  {
    name: 'РитейлМаркет',
    inn: '7709012345',
    industry: 'Розница',
    region: 'Новосибирск',
    phone: '+7 383 100-10-09',
    email: 'sales@retailmarket.example',
    website: 'retailmarket.example',
  },
  {
    name: 'ЭнергоПром',
    inn: '7710123456',
    industry: 'Энергетика',
    region: 'Самара',
    phone: '+7 846 100-10-10',
    email: 'info@energoprom.example',
    website: 'energoprom.example',
  },
];

const FIRST = [
  'Алексей',
  'Мария',
  'Дмитрий',
  'Екатерина',
  'Сергей',
  'Ольга',
  'Иван',
  'Наталья',
  'Павел',
  'Анна',
  'Роман',
  'Юлия',
  'Андрей',
  'Светлана',
  'Михаил',
  'Татьяна',
  'Денис',
  'Елена',
  'Виктор',
  'Оксана',
  'Артём',
  'Ирина',
  'Константин',
  'Людмила',
  'Николай',
  'Галина',
  'Владимир',
  'Маргарита',
];
const LAST = [
  'Кузнецов',
  'Соколова',
  'Морозов',
  'Лебедева',
  'Новиков',
  'Волкова',
  'Соловьёв',
  'Васильева',
  'Зайцев',
  'Павлова',
  'Семёнов',
  'Голубева',
  'Виноградов',
  'Богданова',
  'Воробьёв',
  'Фёдорова',
  'Михайлов',
  'Беляева',
  'Тарасов',
  'Комарова',
  'Орлов',
  'Киселёва',
  'Макаров',
  'Андреева',
  'Ковалёв',
  'Ильина',
  'Гусев',
  'Титова',
];
const POS = [
  'Генеральный директор',
  'Коммерческий директор',
  'Менеджер по закупкам',
  'ИТ-директор',
  'Финансовый директор',
  'Руководитель проекта',
  'Главный бухгалтер',
  'Технический директор',
  'Руководитель отдела продаж',
  'Системный администратор',
];

const DEAL_TOPICS = [
  'Внедрение CRM',
  'Интеграция 1С',
  'Лицензии на год',
  'Техподдержка Premium',
  'Аналитический модуль',
  'Миграция данных',
  'Обучение команды',
  'Доработка API',
  'Пилотный проект',
  'Расширение лицензий',
  'Настройка телефонии',
  'Закупка оборудования',
];

const ORDER_TYPES = [
  {
    id: 'ot-license',
    name: 'Продажа лицензий',
    fields: [
      { key: 'seats', label: 'Кол-во рабочих мест', type: 'NUMBER', required: true, options: [] },
      { key: 'note', label: 'Комментарий', type: 'TEXT', required: false, options: [] },
    ],
    stages: ['Оформление', 'Оплата', 'Активация', 'Завершена'],
  },
  {
    id: 'ot-implementation',
    name: 'Внедрение',
    fields: [
      { key: 'scope', label: 'Объём работ', type: 'TEXT', required: false, options: [] },
      { key: 'note', label: 'Комментарий', type: 'TEXT', required: false, options: [] },
    ],
    stages: ['Договор', 'Аванс', 'Реализация', 'Сдача', 'Завершена'],
  },
  {
    id: 'ot-equipment',
    name: 'Поставка оборудования',
    fields: [
      { key: 'qty', label: 'Количество', type: 'NUMBER', required: true, options: [] },
      { key: 'note', label: 'Комментарий', type: 'TEXT', required: false, options: [] },
    ],
    stages: ['Заказ', 'Оплата', 'Поставка', 'Завершена'],
  },
];

const ACT_TYPES = ['call', 'meeting', 'task'];
const ACT_TITLES = [
  'Первичный звонок клиенту',
  'Уточнить требования',
  'Подготовить КП',
  'Демонстрация системы',
  'Согласовать договор',
  'Перезвонить по итогам встречи',
  'Отправить коммерческое предложение',
  'Контрольный звонок',
  'Встреча с ЛПР',
  'Обсудить условия оплаты',
  'Напомнить об оплате',
  'Финальная презентация',
];

// Демо-«комментарии»/заметки для оживления карточек (модели тредных комментариев
// в платформе нет; роль ленты играют notes + активности + история изменений).
const COMPANY_NOTES = [
  'Ключевой клиент, ведём с прошлого квартала.',
  'Интересуются расширением лицензий.',
  'Запросили коммерческое предложение.',
  'Лояльны, рекомендуют нас партнёрам.',
];
const CONTACT_NOTES = [
  'ЛПР по проекту, выходить через секретаря.',
  'Предпочитает общение по email.',
  'Просил перезвонить после 15:00.',
  'Активно участвует в обсуждении условий.',
];
const DEAL_NOTES = [
  'Клиент сравнивает с конкурентами — подчеркнуть поддержку.',
  'Бюджет согласован, ждём финальное решение.',
  'Нужна демонстрация под их сценарий.',
  'Договорились вернуться к вопросу после праздников.',
];

function digitsPhone(i: number): string {
  const a = 900 + (i % 99);
  const b = 100 + ((i * 7) % 899);
  const c = 10 + ((i * 13) % 89);
  const d = 10 + ((i * 17) % 89);
  return `+7 ${a} ${b}-${c}-${d}`;
}
function normPhone(p: string): string {
  return p.replace(/[^\d+]/g, '');
}
function normEmail(e: string): string {
  return e.trim().toLowerCase();
}
function translit(s: string): string {
  const map: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'c',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
  };
  return s
    .toLowerCase()
    .split('')
    .map((c) => map[c] ?? c)
    .join('');
}

interface SeededDeal {
  _id: ObjectId;
  idx: number;
  companyId: ObjectId | null;
  contactId: ObjectId | null;
  productId: ObjectId | null;
  productName: string;
  assigneeId: string;
  source: string;
  amount: number;
  createdAt: number;
  status: 'open' | 'won' | 'lost';
  stageId: string;
  wonAt: number;
  lostAt: number;
  name: string;
  topic: string;
}

export interface SeedDemoOptions {
  projectId: string;
  ownerId: string;
  assigneeIds?: string[];
  enabledModules: string[];
}

export interface SeedDemoResult {
  seeded: boolean;
  companies: number;
  contacts: number;
  deals: number;
  orders: number;
  activities: number;
  products: number;
}

@Injectable()
export class DemoSeedService {
  private readonly logger = new Logger(DemoSeedService.name);

  constructor(private readonly mongo: MongoService) {}

  /** Стабильный ObjectId из логического ключа (идемпотентность повторного сида). */
  private oid(projectId: string, ...parts: (string | number)[]): ObjectId {
    const h = crypto
      .createHash('md5')
      .update(`${NS}:${projectId}:${parts.join(':')}`)
      .digest('hex');
    return new ObjectId(h.slice(0, 24));
  }

  private async upsert(
    db: Db,
    coll: string,
    _id: ObjectId,
    doc: Record<string, unknown>,
  ): Promise<void> {
    await db
      .collection(coll)
      .updateOne({ _id }, { $set: { ...doc, _id, seedTag: SEED_TAG } }, { upsert: true });
  }

  async seed(opts: SeedDemoOptions): Promise<SeedDemoResult> {
    const projectId = opts.projectId?.trim();
    const ownerId = opts.ownerId?.trim();
    if (!projectId || !ownerId) {
      throw new Error('demo-seed: projectId and ownerId are required');
    }
    const enabled = opts.enabledModules ?? [];
    const has = (m: string) => enabled.includes(m);
    // deals — locked: воронка/сделки/история всегда. Остальное — по модулям.
    const seedCompanies = has('companies');
    const seedContacts = has('contacts');
    const seedProducts = has('products');
    const seedOrders = has('orders');
    const seedActivities = has('activities');

    const ASSIGNEES: string[] = [
      ownerId,
      ...(opts.assigneeIds ?? []).map((s) => s.trim()).filter(Boolean),
    ];

    const NOW = Date.now();
    const startOfMonth = (() => {
      const d = new Date(NOW);
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    })();

    const db = this.mongo.getDb();
    const oid = (...parts: (string | number)[]) => this.oid(projectId, ...parts);
    const upsert = (coll: string, _id: ObjectId, doc: Record<string, unknown>) =>
      this.upsert(db, coll, _id, doc);

    this.logger.log(
      `seeding demo data: project=${projectId} owner=${ownerId} modules=[${enabled.join(',')}]`,
    );

    // ── 1) pipeline + sources + lost reasons (всегда — deals locked) ──────────
    const existingDefault = await db
      .collection('crm_pipelines')
      .findOne({ projectId, isDefault: true });
    const pipelineId = existingDefault?.id ? String(existingDefault.id) : PIPELINE_ID;
    const existingStages =
      (existingDefault?.stages as { id: string; name: string }[] | undefined) ?? [];
    const mergedStages = (() => {
      if (existingStages.length) {
        const ids = new Set(existingStages.map((s) => s.id));
        const extra = STAGES.filter(
          (s) => (s.kind === 'won' || s.kind === 'lost') && !ids.has(s.id),
        );
        return [
          ...existingStages,
          ...extra.map((s) => ({
            id: s.id,
            name: s.name,
            color: s.color,
            order: s.order,
            kind: s.kind,
            probability: s.probability,
          })),
        ];
      }
      return STAGES;
    })();
    const activeStageIds = existingStages.length
      ? existingStages.filter((s) => !['won', 'lost'].includes(s.id)).map((s) => s.id)
      : ACTIVE_STAGE_IDS;
    await upsert('crm_pipelines', existingDefault?._id ?? oid('pipeline'), {
      id: pipelineId,
      projectId,
      name: existingDefault?.name ?? 'Продажи',
      isDefault: true,
      stages: mergedStages,
    });
    for (const s of SOURCES) {
      await upsert('crm_deal_sources', oid('source', s.id), {
        id: s.id,
        projectId,
        name: s.name,
        color: s.color,
      });
    }
    for (const lr of LOST_REASONS) {
      await upsert('crm_lost_reasons', oid('lost-reason', lr.id), {
        id: lr.id,
        projectId,
        name: lr.name,
        order: lr.order,
        active: true,
      });
    }

    // ── 2) products (если включён модуль products) ───────────────────────────
    const productIds: (ObjectId | null)[] = [];
    let productsCount = 0;
    for (let i = 0; i < PRODUCTS.length; i++) {
      if (!seedProducts) {
        productIds.push(null);
        continue;
      }
      const p = PRODUCTS[i];
      const _id = oid('product', i);
      productIds.push(_id);
      await upsert('crm_products', _id, {
        projectId,
        name: p.name,
        description: `${p.category}. Демонстрационная позиция каталога.`,
        category: p.category,
        price: p.price,
        effectivePrice: p.price,
        currency: 'RUB',
        unit: p.unit,
        orderTypeId: '',
        orderTypeName: '',
        orderTypeDangling: false,
        prefill: {},
        status: 'active',
        archivedAt: null,
        ownerDepartmentId: null,
        dealsCount: 0,
        activeDealsCount: 0,
        ordersCount: 0,
        createdAt: NOW - 200 * MS_DAY,
        updatedAt: NOW,
      });
      productsCount++;
    }

    // ── 3) companies (если включён модуль companies) ─────────────────────────
    const companyIds: (ObjectId | null)[] = [];
    let companiesCount = 0;
    for (let i = 0; i < COMPANIES.length; i++) {
      if (!seedCompanies) {
        companyIds.push(null);
        continue;
      }
      const c = COMPANIES[i];
      const _id = oid('company', i);
      companyIds.push(_id);
      const created = new Date(NOW - (180 - i * 6) * MS_DAY);
      await upsert('companies', _id, {
        projectId,
        name: c.name,
        inn: c.inn,
        kpp: `${c.inn.slice(0, 4)}01001`,
        legalAddress: `${c.region}, ул. Центральная, д. ${10 + i}`,
        phone: c.phone,
        email: c.email,
        industry: c.industry,
        region: c.region,
        website: c.website,
        domain: c.website,
        status: i % 3 === 0 ? 'client' : i % 3 === 1 ? 'lead' : 'partner',
        ownerId: pick(ASSIGNEES, i),
        source: 'manual',
        tags: [c.industry],
        notes: pick(COMPANY_NOTES, i),
        createdBy: ownerId,
        updatedBy: ownerId,
        deletedAt: null,
        createdAt: created,
        updatedAt: created,
      });
      companiesCount++;
    }

    // ── 4) contacts (если включён модуль contacts) ───────────────────────────
    const CONTACT_COUNT = 28;
    interface ContactRef {
      _id: ObjectId | null;
      companyIdx: number;
      name: string;
      phone: string;
      email: string;
    }
    const contacts: ContactRef[] = [];
    let contactsCount = 0;
    for (let i = 0; i < CONTACT_COUNT; i++) {
      const companyIdx = i % COMPANIES.length;
      const company = COMPANIES[companyIdx];
      const first = pick(FIRST, i);
      const last = pick(LAST, i);
      const phone = digitsPhone(i);
      const email = `${translit(last)}.${translit(first[0])}@${company.website || 'example.ru'}`;
      const _id = seedContacts ? oid('contact', i) : null;
      contacts.push({ _id, companyIdx, name: `${first} ${last}`, phone, email });
      if (!seedContacts) continue;
      const companyId = companyIds[companyIdx];
      const created = new Date(NOW - (170 - i * 5) * MS_DAY);
      await upsert('contacts', _id!, {
        projectId,
        firstName: first,
        lastName: last,
        middleName: '',
        phone,
        email,
        phoneNormalized: normPhone(phone),
        emailNormalized: normEmail(email),
        position: pick(POS, i),
        companyIds: companyId ? [companyId.toString()] : [],
        source: pick(SOURCES, i).name,
        ownerId: pick(ASSIGNEES, i),
        departmentId: null,
        tags: [],
        notes: pick(CONTACT_NOTES, i),
        mergedInto: null,
        deletedAt: null,
        createdAt: created,
        updatedAt: created,
      });
      contactsCount++;
    }

    // ── 5) order types (если включён модуль orders) ──────────────────────────
    if (seedOrders) {
      for (const ot of ORDER_TYPES) {
        const stages = ot.stages.map((name, order) => ({
          id: `os${order + 1}`,
          name,
          order,
          requiredFieldKeys: [],
          isTerminal: order === ot.stages.length - 1,
        }));
        await upsert('crm_order_types', oid('order-type', ot.id), {
          id: ot.id,
          projectId,
          name: ot.name,
          description: 'Демонстрационный тип продажи.',
          currentVersion: 1,
          deletedAt: null,
          schemaVersion: 1,
          webhookEnabled: false,
          fields: ot.fields,
          stages,
          createdAt: NOW - 190 * MS_DAY,
          updatedAt: NOW,
        });
        await upsert('crm_order_type_revisions', oid('order-type-rev', ot.id, 1), {
          id: `${ot.id}-rev1`,
          projectId,
          orderTypeId: ot.id,
          version: 1,
          status: 'PUBLISHED',
          fields: ot.fields,
          stages,
          finalActionSpec: { type: 'none', config: {} },
          retryPolicy: {
            maxAttempts: 3,
            strategy: 'exponential',
            baseIntervalSec: 30,
            maxWaitSec: 3600,
          },
          documentTemplates: [],
          terminalStageId: stages[stages.length - 1].id,
          createdAt: NOW - 190 * MS_DAY,
          updatedAt: NOW,
        });
      }
    }

    // ── 6) deals (всегда) — воронка + won/lost, кросс-ссылки по модулям ───────
    // Дашборд и «Статистика» по умолчанию показывают период «месяц»: KPI («Сумма
    // сделок / Оборот / Сделок») и воронка считаются по сделкам, СОЗДАННЫМ в
    // текущем месяце (created-at в окне периода). Чтобы на свежесозданном проекте
    // эти числа были заведомо НЕ нулевыми, гарантируем плотную когорту сделок
    // текущего месяца (равномерно от начала месяца до «сейчас»), а остальные
    // раскладываем по истории (~180 дней ДО начала месяца — таймлайн/квартал/год).
    const DEAL_COUNT = 90;
    const CURRENT_MONTH_DEALS = 34; // >1/3 объёма попадает в окно периода «месяц»
    const HISTORY_DEALS = DEAL_COUNT - CURRENT_MONTH_DEALS;
    const stagePlan: { status: 'open' | 'won' | 'lost'; stageId: string }[] = [];
    for (let i = 0; i < DEAL_COUNT; i++) {
      const r = i % 10;
      if (r < 4) stagePlan.push({ status: 'won', stageId: 'won' });
      else if (r < 6) stagePlan.push({ status: 'lost', stageId: 'lost' });
      else stagePlan.push({ status: 'open', stageId: pick(activeStageIds, i) });
    }

    const deals: SeededDeal[] = [];
    for (let i = 0; i < DEAL_COUNT; i++) {
      const _id = oid('deal', i);
      const plan = stagePlan[i];
      const companyIdx = i % COMPANIES.length;
      const company = COMPANIES[companyIdx];
      const companyId = companyIds[companyIdx];
      // контакт из той же компании, где возможно
      const contact =
        contacts.find((c) => c.companyIdx === companyIdx) ?? contacts[i % contacts.length];
      const productIdx = i % PRODUCTS.length;
      const productId = productIds[productIdx];
      const product = PRODUCTS[productIdx];
      const assigneeId = pick(ASSIGNEES, i);
      const source = pick(SOURCES, i).name;
      const topic = pick(DEAL_TOPICS, i);
      const amount = product.price * (1 + (i % 3));
      let createdAt: number;
      if (i < HISTORY_DEALS) {
        // История: равномерно по ~180 дням ДО начала текущего месяца.
        const histStart = startOfMonth - 180 * MS_DAY;
        createdAt = histStart + Math.round((180 * MS_DAY * (i + 1)) / (HISTORY_DEALS + 1));
      } else {
        // Текущий месяц: равномерно от начала месяца до «сейчас». Клампим строго
        // внутрь окна [startOfMonth+1ч, NOW−1ч] — иначе у начала месяца сделки
        // «утекали» бы за границу окна и месячный дашборд обнулялся (баг сида).
        const k = i - HISTORY_DEALS;
        const frac = (k + 1) / (CURRENT_MONTH_DEALS + 1);
        const raw = startOfMonth + Math.round(Math.max(MS_DAY, NOW - startOfMonth) * frac);
        createdAt = Math.min(NOW - 3_600_000, Math.max(startOfMonth + 3_600_000, raw));
      }
      const wonAt = plan.status === 'won' ? Math.min(NOW, createdAt + (5 + (i % 25)) * MS_DAY) : 0;
      const lostAt =
        plan.status === 'lost' ? Math.min(NOW, createdAt + (3 + (i % 20)) * MS_DAY) : 0;
      const closedAt = wonAt || lostAt || 0;
      const name = `${topic} — ${company.name}`;

      const stageLog: {
        stageId: string;
        enteredAt: number;
        exitedAt?: number;
        movedBy: string;
        kind: string;
      }[] = [];
      const targetStageId = plan.stageId;
      const targetIdx =
        plan.status === 'open' ? activeStageIds.indexOf(targetStageId) : activeStageIds.length - 1;
      const span = (closedAt || NOW) - createdAt;
      for (let s = 0; s <= Math.max(0, targetIdx); s++) {
        const enteredAt =
          createdAt +
          Math.round((span * s) / Math.max(1, targetIdx + (plan.status === 'open' ? 0 : 1)));
        stageLog.push({
          stageId: activeStageIds[s],
          enteredAt,
          movedBy: assigneeId,
          kind: s === 0 ? 'create' : 'move',
        });
      }
      if (plan.status !== 'open') {
        stageLog.push({
          stageId: targetStageId,
          enteredAt: closedAt || NOW,
          movedBy: assigneeId,
          kind: 'move',
        });
      }
      for (let s = 0; s < stageLog.length - 1; s++)
        stageLog[s].exitedAt = stageLog[s + 1].enteredAt;

      const lostReasonId = plan.status === 'lost' ? pick(LOST_REASONS, i).id : '';

      deals.push({
        _id,
        idx: i,
        companyId: companyId ?? null,
        contactId: contact?._id ?? null,
        productId: productId ?? null,
        productName: product.name,
        assigneeId,
        source,
        amount,
        createdAt,
        status: plan.status,
        stageId: targetStageId,
        wonAt,
        lostAt,
        name,
        topic,
      });

      await upsert('crm_deals', _id, {
        projectId,
        pipelineId,
        stageId: targetStageId,
        name,
        amount,
        currency: 'RUB',
        contactId: contact?._id ? contact._id.toString() : '',
        companyId: companyId ? companyId.toString() : '',
        productId: productId ? productId.toString() : '',
        productName: product.name,
        assigneeId,
        departmentId: '',
        source,
        status: plan.status,
        probability: STAGES.find((s) => s.id === targetStageId)?.probability ?? 0,
        expectedCloseDate: createdAt + 30 * MS_DAY,
        wonAt: wonAt || undefined,
        lostAt: lostAt || undefined,
        closedAt: closedAt || undefined,
        wonVersion: plan.status === 'won' ? 1 : undefined,
        lostReasonId: lostReasonId || undefined,
        lostReasonComment: plan.status === 'lost' ? 'Демо: причина проигрыша' : undefined,
        result: plan.status === 'won' ? 'won' : plan.status === 'lost' ? 'lost' : '',
        // «light»-поля: если контакт/компания не созданы (модуль выключен) — карточка
        // всё равно осмысленна (имя/компания строкой).
        lightName: contact && !contact._id ? contact.name : '',
        lightPhone: contact && !contact._id ? contact.phone : '',
        lightEmail: contact && !contact._id ? contact.email : '',
        lightCompanyName: companyId ? '' : company.name,
        notes: pick(DEAL_NOTES, i),
        tags: [topic],
        stageLog,
        createdAt,
        updatedAt: closedAt || NOW,
        stageEnteredAt: stageLog[stageLog.length - 1].enteredAt,
        deletedAt: null,
      });

      for (let s = 0; s < stageLog.length; s++) {
        const e = stageLog[s];
        await upsert('crm_deal_stage_history', oid('stage-history', i, s), {
          projectId,
          dealId: _id.toString(),
          pipelineId,
          fromStageId: s === 0 ? '' : stageLog[s - 1].stageId,
          toStageId: e.stageId,
          enteredAt: e.enteredAt,
          movedBy: e.movedBy,
          kind: e.kind,
          createdAt: e.enteredAt,
        });
      }
    }
    const wonDeals = deals.filter((d) => d.status === 'won');
    const openDeals = deals.filter((d) => d.status === 'open');

    // ── 7) orders (если включён модуль orders) — на выигранных/открытых сделках ─
    const ORDER_CAP = 40;
    const orderSourceDeals = seedOrders
      ? [...wonDeals, ...openDeals.slice(0, Math.max(0, ORDER_CAP - wonDeals.length))].slice(
          0,
          ORDER_CAP,
        )
      : [];
    let ordersCount = 0;
    for (let i = 0; i < orderSourceDeals.length; i++) {
      const d = orderSourceDeals[i];
      const _id = oid('order', i);
      const ot = ORDER_TYPES[i % ORDER_TYPES.length];
      const stages = ot.stages;
      const isCancelled = i % 11 === 10;
      const stageIdx = isCancelled ? 0 : d.status === 'won' ? stages.length - 1 : i % stages.length;
      const stageId = `os${stageIdx + 1}`;
      const createdAt = (d.wonAt || d.createdAt) + 2 * MS_DAY;
      const fields = ot.fields.reduce<Record<string, unknown>>((acc, f) => {
        if (f.key === 'seats') acc[f.key] = 5 + (i % 20);
        else if (f.key === 'qty') acc[f.key] = 1 + (i % 5);
        else if (f.key === 'scope') acc[f.key] = 'Полное внедрение модулей CRM';
        else acc[f.key] = 'Демо-продажа';
        return acc;
      }, {});
      await upsert('crm_orders', _id, {
        projectId,
        typeId: ot.id,
        orderTypeVersion: 1,
        number: `ORD-${1000 + i}`,
        dealId: d._id.toString(),
        dealName: d.name,
        contactId: d.contactId ? d.contactId.toString() : '',
        companyId: d.companyId ? d.companyId.toString() : '',
        productId: d.productId ? d.productId.toString() : '',
        productName: d.productName,
        assigneeId: d.assigneeId,
        stageId,
        stageChangedAt: createdAt,
        snapshot: {
          contact: {},
          company: {},
          capturedAt: createdAt,
          contactSourceHash: '',
          companySourceHash: '',
        },
        fieldsJson: JSON.stringify(fields),
        status: isCancelled ? 'CANCELLED' : 'ACTIVE',
        cancelReason: isCancelled ? 'Демо: отказ клиента' : '',
        hasDrift: false,
        finalActionState: { status: 'IDLE', payloadGen: 1, attempts: [] },
        amount: d.amount,
        currency: 'RUB',
        createdAt,
        updatedAt: createdAt,
        createdBy: d.assigneeId,
      });
      ordersCount++;
    }

    // ── 8) activities (если включён модуль activities) ───────────────────────
    const ACT_COUNT = 45;
    let activitiesCount = 0;
    const seededActivities: {
      _id: ObjectId;
      assigneeId: string;
      createdAt: number;
      status: string;
      completedAt: number | null;
      title: string;
    }[] = [];
    if (seedActivities) {
      for (let i = 0; i < ACT_COUNT; i++) {
        const _id = oid('activity', i);
        const d = deals[i % deals.length];
        const type = pick(ACT_TYPES, i);
        const assigneeId = d.assigneeId;
        const bucket = i % 3;
        let dueAt: number;
        let actStatus: string;
        let completedAt: number | null = null;
        if (bucket === 0) {
          dueAt = NOW - (1 + (i % 10)) * MS_DAY;
          actStatus = 'planned';
        } else if (bucket === 1) {
          dueAt = NOW - (1 + (i % 14)) * MS_DAY;
          actStatus = 'completed';
          completedAt = dueAt + 3_600_000;
        } else {
          dueAt = NOW + (1 + (i % 7)) * MS_DAY;
          actStatus = 'planned';
        }
        const title = pick(ACT_TITLES, i);
        const createdAt = Math.min(dueAt, NOW) - 2 * MS_DAY;
        const links: {
          entityType: string;
          entityId: string;
          nameSnapshot: string;
          orphaned: boolean;
        }[] = [
          { entityType: 'deal', entityId: d._id.toString(), nameSnapshot: d.name, orphaned: false },
        ];
        if (d.contactId)
          links.push({
            entityType: 'contact',
            entityId: d.contactId.toString(),
            nameSnapshot: '',
            orphaned: false,
          });
        if (d.companyId)
          links.push({
            entityType: 'company',
            entityId: d.companyId.toString(),
            nameSnapshot: '',
            orphaned: false,
          });
        await upsert('crm_activities', _id, {
          projectId,
          type,
          title,
          description: 'Демонстрационная активность.',
          status: actStatus,
          priority: pick(['low', 'medium', 'high'], i),
          dueDate: dueAt,
          startDate: type === 'meeting' ? dueAt : null,
          endDate: type === 'meeting' ? dueAt + 3_600_000 : null,
          allDay: false,
          direction: type === 'call' ? (i % 2 ? 'outbound' : 'inbound') : '',
          duration: type === 'meeting' ? 60 : null,
          actualDuration: null,
          location: type === 'meeting' ? 'Офис клиента' : '',
          participants: [],
          assigneeId,
          createdBy: assigneeId,
          dueAt,
          ownerId: assigneeId,
          links,
          result: '',
          reminderOffset: 'none',
          reminderFireAt: null,
          reminderState: 'none',
          completedAt,
          deletedAt: null,
          createdAt,
          updatedAt: NOW,
        });
        seededActivities.push({
          _id,
          assigneeId,
          createdAt,
          status: actStatus,
          completedAt,
          title,
        });
        activitiesCount++;
      }
    }

    // ── 9) audit history («История изменений») — всегда ──────────────────────
    const auditRow = async (
      ns: string,
      seq: number,
      when: number,
      actorId: string,
      eventName: string,
      entityType: string,
      entityId: string,
      payload: Record<string, unknown>,
    ) => {
      await upsert('audit_events', oid('audit', ns, seq), {
        projectId,
        eventName,
        entityType,
        entityId,
        actorId,
        actorType: 'user',
        payloadJson: JSON.stringify(payload),
        requestId: '',
        traceId: '',
        createdAt: when,
      });
    };
    for (const d of deals) {
      let seq = 0;
      await auditRow(
        `deal:${d.idx}`,
        seq++,
        d.createdAt,
        d.assigneeId,
        'crm.deal.created',
        'deal',
        d._id.toString(),
        { name: d.name, amount: d.amount, source: d.source, stageId: activeStageIds[0] },
      );
      const moveAt1 = d.createdAt + 3 * MS_DAY;
      await auditRow(
        `deal:${d.idx}`,
        seq++,
        moveAt1,
        d.assigneeId,
        'crm.deal.stage_changed',
        'deal',
        d._id.toString(),
        { from: activeStageIds[0], to: activeStageIds[Math.min(1, activeStageIds.length - 1)] },
      );
      if (d.status === 'won') {
        await auditRow(
          `deal:${d.idx}`,
          seq,
          d.wonAt,
          d.assigneeId,
          'crm.deal.won',
          'deal',
          d._id.toString(),
          { amount: d.amount, wonAt: d.wonAt },
        );
      } else if (d.status === 'lost') {
        await auditRow(
          `deal:${d.idx}`,
          seq,
          d.lostAt,
          d.assigneeId,
          'crm.deal.lost',
          'deal',
          d._id.toString(),
          { lostAt: d.lostAt, reason: 'lr' },
        );
      }
    }
    for (let i = 0; i < orderSourceDeals.length; i++) {
      const d = orderSourceDeals[i];
      const orderId = oid('order', i).toString();
      await auditRow(
        `order:${i}`,
        0,
        (d.wonAt || d.createdAt) + 2 * MS_DAY,
        d.assigneeId,
        'crm.order.created',
        'order',
        orderId,
        { number: `ORD-${1000 + i}`, dealId: d._id.toString() },
      );
    }
    // Компании: создание + демонстрационное изменение (смена статуса) — таймлайн
    // на карточке компании (UI читает audit_events по entityType+entityId).
    if (seedCompanies) {
      for (let i = 0; i < COMPANIES.length; i++) {
        const cid = companyIds[i];
        if (!cid) continue;
        const created = NOW - (180 - i * 6) * MS_DAY;
        const actor = pick(ASSIGNEES, i);
        const newStatus = i % 3 === 0 ? 'client' : i % 3 === 1 ? 'lead' : 'partner';
        await auditRow(
          `company:${i}`,
          0,
          created,
          ownerId,
          'crm.company.created',
          'company',
          cid.toString(),
          { name: COMPANIES[i].name },
        );
        await auditRow(
          `company:${i}`,
          1,
          created + 7 * MS_DAY,
          actor,
          'crm.company.updated',
          'company',
          cid.toString(),
          {
            companyId: cid.toString(),
            changedFields: [{ field: 'status', old: 'lead', new: newStatus }],
            userId: actor,
          },
        );
      }
    }
    // Контакты: создание + изменение (заполнили должность).
    if (seedContacts) {
      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        if (!c._id) continue;
        const created = NOW - (170 - i * 5) * MS_DAY;
        const actor = pick(ASSIGNEES, i);
        await auditRow(
          `contact:${i}`,
          0,
          created,
          ownerId,
          'crm.contact.created',
          'contact',
          c._id.toString(),
          { name: c.name },
        );
        await auditRow(
          `contact:${i}`,
          1,
          created + 5 * MS_DAY,
          actor,
          'crm.contact.updated',
          'contact',
          c._id.toString(),
          {
            contactId: c._id.toString(),
            changedFields: [{ field: 'position', old: '', new: pick(POS, i) }],
            userId: actor,
          },
        );
      }
    }
    // Продукты: создание.
    if (seedProducts) {
      for (let i = 0; i < productIds.length; i++) {
        const pid = productIds[i];
        if (!pid) continue;
        await auditRow(
          `product:${i}`,
          0,
          NOW - 200 * MS_DAY,
          ownerId,
          'crm.product.created',
          'product',
          pid.toString(),
          { name: PRODUCTS[i].name, price: PRODUCTS[i].price },
        );
      }
    }
    // Активности: создание (+ завершение для выполненных).
    if (seedActivities) {
      for (const a of seededActivities) {
        await auditRow(
          `activity:${a._id.toString()}`,
          0,
          a.createdAt,
          a.assigneeId,
          'crm.activity.created',
          'activity',
          a._id.toString(),
          { title: a.title },
        );
        if (a.status === 'completed' && a.completedAt) {
          await auditRow(
            `activity:${a._id.toString()}`,
            1,
            a.completedAt,
            a.assigneeId,
            'crm.activity.completed',
            'activity',
            a._id.toString(),
            { completedAt: a.completedAt },
          );
        }
      }
    }

    // ── 10) денормализованные счётчики на продуктах ──────────────────────────
    if (seedProducts) {
      for (let p = 0; p < productIds.length; p++) {
        const pid = productIds[p];
        if (!pid) continue;
        const pidStr = pid.toString();
        const linkedDeals = deals.filter((d) => d.productId?.toString() === pidStr);
        const activeLinked = linkedDeals.filter((d) => d.status === 'open');
        const linkedOrders = orderSourceDeals.filter((d) => d.productId?.toString() === pidStr);
        await db.collection('crm_products').updateOne(
          { _id: pid },
          {
            $set: {
              dealsCount: linkedDeals.length,
              activeDealsCount: activeLinked.length,
              ordersCount: linkedOrders.length,
            },
          },
        );
      }
    }

    // ── 11) правила автоматизации (если включён модуль automation) ────────────
    // Пишем напрямую в automation_rules (snake_case-схема домена automation).
    // Включённые правила сработают на БУДУЩИХ событиях проекта; ретроактивно по
    // сидовым сделкам не срабатывают (сид пишет в Mongo, минуя шину).
    let automationRulesCount = 0;
    if (has('automation')) {
      const kpStageId = activeStageIds[Math.min(2, activeStageIds.length - 1)];
      const RULES: {
        key: string;
        name: string;
        description: string;
        enabled: boolean;
        requires?: string;
        trigger: Record<string, unknown>;
        actions: unknown[];
      }[] = [
        {
          key: 'new-deal-call',
          name: 'Новая сделка → задача «Перезвонить»',
          description: 'При создании сделки ставит задачу-звонок ответственному.',
          enabled: true,
          requires: 'activities',
          trigger: { event_name: 'crm.deal.created' },
          actions: [
            {
              type: 'create_activity',
              config: { type: 'call', title: 'Перезвонить по новой сделке' },
            },
          ],
        },
        {
          key: 'kp-stage-task',
          name: 'Этап «КП» → подготовить КП',
          description:
            'Когда сделка переходит на этап КП — создаёт задачу подготовить коммерческое предложение.',
          enabled: true,
          requires: 'activities',
          trigger: { event_name: 'crm.deal.stage_changed', toStage: kpStageId },
          actions: [{ type: 'create_activity', config: { type: 'task', title: 'Подготовить КП' } }],
        },
        {
          key: 'deal-won-notify',
          name: 'Сделка выиграна → уведомление',
          description: 'Отправляет уведомление ответственному при выигрыше сделки.',
          enabled: true,
          trigger: { event_name: 'crm.deal.won' },
          actions: [{ type: 'send_notification', config: { template: 'deal_won' } }],
        },
        {
          key: 'new-contact-assign',
          name: 'Новый контакт → назначить ответственного',
          description:
            'Демонстрация отключённого правила: назначение ответственного на новый контакт.',
          enabled: false,
          requires: 'contacts',
          trigger: { event_name: 'crm.contact.created' },
          actions: [{ type: 'assign_user', config: { userId: ownerId } }],
        },
      ];
      const ruleCreatedAt = NOW - 30 * MS_DAY;
      for (const r of RULES) {
        if (r.requires && !has(r.requires)) continue;
        await upsert('automation_rules', oid('automation-rule', r.key), {
          id: `demo-${r.key}`,
          project_id: projectId,
          name: r.name,
          description: r.description,
          enabled: r.enabled,
          trigger_type: 'event',
          trigger_config_json: JSON.stringify(r.trigger),
          conditions_json: '[]',
          actions_json: JSON.stringify(r.actions),
          created_at: ruleCreatedAt,
          updated_at: ruleCreatedAt,
          last_executed_at: 0,
          state: r.enabled ? 'enabled' : 'disabled',
          priority: 100,
          created_by: ownerId,
          notify_on_failure: '',
          unexecutable: false,
          stats_json: '{}',
        });
        automationRulesCount++;
      }
    }
    if (automationRulesCount) {
      this.logger.log(
        `demo automation rules seeded for project=${projectId}: ${automationRulesCount}`,
      );
    }

    const result: SeedDemoResult = {
      seeded: true,
      companies: companiesCount,
      contacts: contactsCount,
      deals: deals.length,
      orders: ordersCount,
      activities: activitiesCount,
      products: productsCount,
    };
    this.logger.log(`demo data seeded for project=${projectId}: ${JSON.stringify(result)}`);
    return result;
  }
}
