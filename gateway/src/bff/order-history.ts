/**
 * TODO-414 — лента изменений продажи (карточка «История»).
 *
 * Данные для неё уже существовали и не доходили до пользователя: домен orders
 * пишет `crm.order.*` в outbox с `subject = order/<id>`, audit биндится на
 * `crm.#` (audit/src/audit/audit.service.ts:24) и раскладывает subject в
 * `entityType/entityId` (audit/src/chain/audit-chain.service.ts:125-128). То
 * есть неизменяемая цепочка уже хранит историю каждой продажи — не было только
 * BFF-ручки и фронта, поэтому карточка синтезировала два фиктивных события.
 *
 * Здесь — чистое (без IO) отображение строки `AuditGrpc.AuditEvent` в элемент
 * истории того же вида, что у контактов и компаний (`{id, type, userId,
 * userName, timestamp, summary, changedFields}`), плюс перевод сырых id в
 * человеческие подписи: этап — по спецификации ревизии типа, ответственный и
 * автор события — по батч-резолву user-directory, статус — по словарю ниже.
 * Файл отдельный (а не ещё сто строк в crm-bff.controller.ts) ровно потому, что
 * это pure-функции: их можно накрыть юнит-тестом без Nest-контекста.
 */

/** `AuditGrpc.event_name` → подпись события в карточке. */
const ORDER_HISTORY_LABELS: Record<string, string> = {
  'crm.order.created': 'Продажа создана',
  'crm.order.updated': 'Изменены данные продажи',
  'crm.order.stage_changed': 'Смена этапа',
  'crm.order.status_changed': 'Смена статуса',
  'crm.order.cancelled': 'Продажа отменена',
  'crm.order.drift_accepted': 'Принят дрейф типа продажи',
  'crm.order.final_action_requested': 'Запрошена финальная отправка',
};

/**
 * Коды статусов продажи → подписи. Дублировать словарь фронта (orderUtils
 * `ORDER_STATUS_CONFIG`) здесь не грех: changedFields — это уже готовый к показу
 * текст, и раскрашивать сырые коды в каждом потребителе истории было бы хуже.
 */
const ORDER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Активна',
  SENDING: 'Отправка',
  DONE: 'Оформлена',
  SEND_ERROR: 'Ошибка отправки',
  CANCELLED: 'Отменена',
};

export type OrderHistoryContext = {
  /** stageId → название этапа (из ревизии типа продажи). */
  stageNameById: Map<string, string>;
  /** ключ пользовательского поля → его человеческая подпись. */
  fieldLabelByKey: Map<string, string>;
  /** userId → ФИО (батч-резолв через user-directory). */
  userNameById: Map<string, string>;
};

export type OrderHistoryChange = { field: string; old: string; new: string };

export function emptyOrderHistoryContext(): OrderHistoryContext {
  return {
    stageNameById: new Map(),
    fieldLabelByKey: new Map(),
    userNameById: new Map(),
  };
}

function scalar(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** id пользователя → ФИО, с честным fallback на сам id (фейков не подставляем). */
function userName(id: string, ctx: OrderHistoryContext): string {
  if (!id) return '';
  return ctx.userNameById.get(id) ?? id;
}

function stageName(id: unknown, ctx: OrderHistoryContext): string {
  const key = scalar(id);
  if (!key) return '';
  return ctx.stageNameById.get(key) ?? key;
}

/** Разбор одного события в набор изменений «поле: было → стало». */
function orderHistoryChanges(
  eventName: string,
  payload: Record<string, unknown>,
  ctx: OrderHistoryContext,
): OrderHistoryChange[] {
  switch (eventName) {
    case 'crm.order.stage_changed':
      return [
        {
          field: 'Этап',
          old: stageName(payload.fromStageId, ctx),
          new: stageName(payload.toStageId, ctx),
        },
      ];
    case 'crm.order.status_changed': {
      const from = scalar(payload.from);
      const to = scalar(payload.to);
      return [
        {
          field: 'Статус',
          old: ORDER_STATUS_LABELS[from] ?? from,
          new: ORDER_STATUS_LABELS[to] ?? to,
        },
      ];
    }
    case 'crm.order.cancelled': {
      const reason = scalar(payload.reason);
      return reason ? [{ field: 'Причина отмены', old: '', new: reason }] : [];
    }
    case 'crm.order.updated': {
      const before = obj(payload.before);
      const after = obj(payload.after);
      const changes: OrderHistoryChange[] = [];
      if (before.assigneeId !== undefined || after.assigneeId !== undefined) {
        changes.push({
          field: 'Ответственный',
          old: userName(scalar(before.assigneeId), ctx),
          new: userName(scalar(after.assigneeId), ctx),
        });
      }
      const beforeFields = obj(before.customFields);
      const afterFields = obj(after.customFields);
      const keys = [...new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])].sort();
      for (const key of keys) {
        const oldValue = scalar(beforeFields[key]);
        const newValue = scalar(afterFields[key]);
        // Домен присылает СНИМКИ customFields целиком, а не дельту: без этого
        // фильтра каждое сохранение показывало бы «изменение» всех полей формы.
        if (oldValue === newValue) continue;
        changes.push({ field: ctx.fieldLabelByKey.get(key) ?? key, old: oldValue, new: newValue });
      }
      return changes;
    }
    default:
      return [];
  }
}

/**
 * id пользователей, встречающиеся в пачке событий (автор события + прежний/новый
 * ответственный). Собираются заранее, чтобы резолвить имена ОДНИМ батчем на
 * запрос, а не по вызову на строку истории.
 */
export function collectOrderHistoryUserIds(events: Record<string, unknown>[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    const actor = scalar(e.actor_id ?? e.actorId);
    if (actor) ids.add(actor);
    const payload = parsePayload(e.payload_json ?? e.payloadJson);
    const before = obj(payload.before);
    const after = obj(payload.after);
    for (const v of [before.assigneeId, after.assigneeId, payload.acceptedBy, payload.ownerId]) {
      const id = scalar(v);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** `AuditGrpc.AuditEvent` (snake_case, keepCase-loader) → элемент истории для фронта. */
export function orderHistoryItemFe(e: Record<string, unknown>, ctx: OrderHistoryContext) {
  const eventName = scalar(e.event_name ?? e.eventName);
  const actorId = scalar(e.actor_id ?? e.actorId);
  const actorType = scalar(e.actor_type ?? e.actorType);
  return {
    id: scalar(e.id),
    type: eventName,
    userId: actorId,
    // Системные факты (сага финальной отправки, воркеры) автора-человека не
    // имеют — подписываем их честно, а не именем ответственного за продажу.
    userName: actorId ? userName(actorId, ctx) : actorType === 'service' ? 'Система' : '',
    timestamp: Number(e.created_at ?? e.createdAt ?? 0),
    summary: ORDER_HISTORY_LABELS[eventName] ?? eventName,
    changedFields: orderHistoryChanges(
      eventName,
      parsePayload(e.payload_json ?? e.payloadJson),
      ctx,
    ),
  };
}
