/**
 * Каталог базовых шаблонов проекта (спека §6.2 — «Базовые шаблоны v1, 5 штук, захардкожены»).
 *
 * Единый источник правды для инстанцирования проекта по шаблону:
 *  - домен `pipe` берёт `pipeline` + `dealSources` (воронка/этапы/источники сделок);
 *  - домен `orders` берёт `orderTypes` (типы продаж: поля + этапы оформления).
 *
 * Модули (`modules`) перечислены для документации/подсказки фронту при выборе шаблона;
 * фактический набор включённых модулей проекта приходит из CreateProject (см. module-registry).
 *
 * Шаблон предзаполняет воронку и типы продаж — всё можно изменить после создания.
 */

export interface ProjectTemplatePipelineStage {
  id: string;
  name: string;
  color: string;
  /**
   * Классификатор стадии `active | won | lost` (BX-FLOW-1). Терминальные стадии
   * `won`/`lost` нужны, чтобы `closeDeal` переносил карточку в терминал, а KPI
   * «Выиграно» и воронка различали выигранные/проигранные сделки.
   */
  kind: 'active' | 'won' | 'lost';
}

export interface ProjectTemplatePipeline {
  name: string;
  stages: ProjectTemplatePipelineStage[];
}

export interface ProjectTemplateDealSource {
  id: string;
  name: string;
  color: string;
}

export interface ProjectTemplateOrderTypeField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
}

export interface ProjectTemplateOrderTypeStage {
  id: string;
  name: string;
}

export interface ProjectTemplateOrderType {
  id: string;
  name: string;
  fields: ProjectTemplateOrderTypeField[];
  stages: ProjectTemplateOrderTypeStage[];
}

export interface ProjectTemplate {
  id: string;
  name: string;
  /**
   * Краткое описание шаблона «для кого / что включено» (FR-ONB-16/18).
   * Показывается на шаге 1 мастера создания проекта; обратносовместимо опционально.
   */
  description?: string;
  /** Подсказка по модулям (спека §6.2). Авторитетный набор модулей задаётся в CreateProject. */
  modules: string[];
  pipeline: ProjectTemplatePipeline;
  dealSources: ProjectTemplateDealSource[];
  orderTypes: ProjectTemplateOrderType[];
}

export const DEFAULT_TEMPLATE_ID = 'default';

/** Палитра для этапов воронки; последний этап подкрашиваем «успехом». */
const STAGE_PALETTE = [
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#eab308', // amber
  '#f97316', // orange
  '#06b6d4', // cyan
  '#0ea5e9', // sky
];
const STAGE_SUCCESS_COLOR = '#22c55e';

/**
 * Строит этапы воронки из списка названий: id `s1..sN`, цвета из палитры.
 * Последний названный этап — терминальный «успех» (`kind:'won'`, зелёный);
 * следом добавляется терминальный этап проигрыша (`kind:'lost'`), чтобы у каждой
 * воронки был явный won/lost-терминал (BX-FLOW-1).
 */
function buildStages(names: string[]): ProjectTemplatePipelineStage[] {
  const last = names.length - 1;
  const stages: ProjectTemplatePipelineStage[] = names.map((name, i) => ({
    id: `s${i + 1}`,
    name,
    color: i === last ? STAGE_SUCCESS_COLOR : STAGE_PALETTE[i % STAGE_PALETTE.length],
    kind: i === last ? 'won' : 'active',
  }));
  stages.push({ id: `s${names.length + 1}`, name: 'Проигрыш', color: '#ef4444', kind: 'lost' });
  return stages;
}

/** Строит этапы оформления для типа продажи: id `os1..osN`. */
function buildOrderStages(names: string[]): ProjectTemplateOrderTypeStage[] {
  return names.map((name, i) => ({ id: `os${i + 1}`, name }));
}

/** Поле «Комментарий» по умолчанию для типов продаж (как в текущем ensureTypes). */
const DEFAULT_ORDER_FIELDS: ProjectTemplateOrderTypeField[] = [
  { key: 'note', label: 'Комментарий', type: 'TEXT', required: false, options: [] },
];

/** Источники сделок по умолчанию (единый источник правды для provisionDefaults и ensureProject). */
export const DEFAULT_DEAL_SOURCES: ProjectTemplateDealSource[] = [
  { id: 'ds1', name: 'Сайт', color: '#6366f1' },
  { id: 'ds2', name: 'Звонок', color: '#8b5cf6' },
  { id: 'ds3', name: 'Заявка', color: '#22c55e' },
];

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'b2b-sales',
    name: 'Продажи B2B',
    description:
      'Для отделов продаж B2B: длинный цикл сделки с КП и переговорами, продукты, типы продаж, документы и отчёты.',
    modules: [
      'contacts',
      'companies',
      'deals',
      'products',
      'orders',
      'activities',
      'documents',
      'reports',
    ],
    pipeline: {
      name: 'Продажи B2B',
      stages: buildStages([
        'Обращение',
        'Квалификация',
        'КП',
        'Переговоры',
        'Согласование',
        'Оформление',
      ]),
    },
    dealSources: DEFAULT_DEAL_SOURCES,
    orderTypes: [
      {
        id: 'ot-b2b',
        name: 'Стандартная продажа',
        fields: DEFAULT_ORDER_FIELDS,
        stages: buildOrderStages(['Оформление', 'Оплата', 'Исполнение', 'Завершена']),
      },
    ],
  },
  {
    id: 'call-center',
    name: 'Колл-центр',
    description:
      'Для обработки входящих обращений: быстрая квалификация и передача в продажи; без модуля типов продаж.',
    modules: ['contacts', 'deals', 'activities', 'reports'],
    pipeline: {
      name: 'Обработка обращений',
      stages: buildStages(['Входящий', 'Обработка', 'Квалификация', 'Передан в продажи']),
    },
    dealSources: DEFAULT_DEAL_SOURCES,
    // Модуль «Продажи» в шаблоне не включён — типы продаж не создаём.
    orderTypes: [],
  },
  {
    id: 'car-dealer',
    name: 'Автосалон',
    description:
      'Для автосалонов: показ → тест-драйв → trade-in → выдача; продажа автомобиля с этапами оформления.',
    modules: [
      'contacts',
      'companies',
      'deals',
      'products',
      'orders',
      'activities',
      'documents',
      'reports',
    ],
    pipeline: {
      name: 'Продажи авто',
      stages: buildStages([
        'Обращение',
        'Показ',
        'Тест-драйв',
        'КП',
        'Trade-in',
        'Сделка',
        'Выдача',
      ]),
    },
    dealSources: DEFAULT_DEAL_SOURCES,
    orderTypes: [
      {
        id: 'ot-car',
        name: 'Продажа автомобиля',
        fields: DEFAULT_ORDER_FIELDS,
        stages: buildOrderStages(['Договор', 'Оплата', 'Подготовка', 'Выдача']),
      },
    ],
  },
  {
    id: 'delivery',
    name: 'Доставка',
    description:
      'Для служб доставки: заявка → комплектация → доставка; доставка заказа с этапами сборки и маршрута.',
    modules: ['contacts', 'deals', 'products', 'orders', 'reports'],
    pipeline: {
      name: 'Доставка',
      stages: buildStages(['Заявка', 'Подтверждение', 'Готовится', 'В пути', 'Доставлен']),
    },
    dealSources: DEFAULT_DEAL_SOURCES,
    orderTypes: [
      {
        id: 'ot-delivery',
        name: 'Доставка заказа',
        fields: DEFAULT_ORDER_FIELDS,
        stages: buildOrderStages(['Сборка', 'Передача в доставку', 'В пути', 'Доставлен']),
      },
    ],
  },
  {
    id: DEFAULT_TEMPLATE_ID,
    name: 'По умолчанию',
    description:
      'Универсальный старт: простая воронка продаж и базовые модули; подойдёт, если не уверены в выборе.',
    modules: ['contacts', 'companies', 'deals', 'activities', 'reports'],
    pipeline: {
      name: 'Воронка продаж',
      stages: buildStages(['Новая', 'В работе', 'Завершена']),
    },
    dealSources: DEFAULT_DEAL_SOURCES,
    orderTypes: [],
  },
];

const TEMPLATES_BY_ID = new Map(PROJECT_TEMPLATES.map((t) => [t.id, t]));

/**
 * Возвращает шаблон по id. Если id не передан/неизвестен — шаблон «По умолчанию»
 * (инстанцирование должно быть детерминированным даже при пустом/легаси templateId).
 */
export function getProjectTemplate(templateId?: string | null): ProjectTemplate {
  if (templateId) {
    const found = TEMPLATES_BY_ID.get(templateId);
    if (found) return found;
  }
  return TEMPLATES_BY_ID.get(DEFAULT_TEMPLATE_ID) as ProjectTemplate;
}
