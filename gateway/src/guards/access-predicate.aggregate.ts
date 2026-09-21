/**
 * ABAC push-down for AGGREGATE routes (statistics/dashboard/reports run·drill·export).
 *
 * Проблема, которую закрывает файл (ревью волны «Статистика», major).
 * `compileAccessPredicate` компилирует предикат по subject'у МАРШРУТА. Для CRM-роутов
 * это верно (`/deals` → subject `deals` → предикат про сделки), а для статистики —
 * нет: ответ агрегата собирается из ПЯТИ чужих коллекций (deals/orders/contacts/
 * companies/activities), а subject маршрута — `statistics`/`reports`. Отсюда два
 * следствия старого поведения:
 *
 *  1. НЕДОСУЖЕНИЕ (небезопасно). Правило политики на `deals` («не видеть сделки
 *     дороже X» / «только своего отдела») в агрегатах НЕ применялось вовсе —
 *     `ruleApplies` требует совпадения subject'а. В списке сделок запись скрыта,
 *     а её сумма и позиция в воронке видны в статистике.
 *  2. ПЕРЕСУЖЕНИЕ. Один и тот же mongo-фрагмент от правила на `statistics`
 *     (например `record.ownerId`) уезжал во все пять коллекций, включая
 *     activities, где владелец называется `assigneeId` — срез молча пустел.
 *     Направление безопасное, но данные врут.
 *  3. БЕЗУСЛОВНЫЙ DENY НА ИСТОЧНИК не доезжал вовсе (небезопасно). Правило без
 *     условия — сплошной запрет пары subject:action; на своём маршруте его
 *     enforce-ит гейт (403), но у агрегата subject другой, а построчного
 *     фрагмента у такого правила нет. Итог: `deny activities:read` закрывал
 *     `/api/v1/activities`, а `GET /dashboard` продолжал отдавать overdue/
 *     upcoming/recent с id, заголовками и владельцами тех же активностей.
 *     Закрывается deny-all-фрагментом источника (DENY_ALL_MONGO ниже).
 *
 * Решение — набор предикатов ПО ИСТОЧНИКАМ, скомпилированный там же, где и
 * маршрутный (на gateway: единый компилятор, единая fail-safe-семантика — RFC-5
 * §1.4, RFC-ABAC §7.1). Транспорт — тот же ключ метадаты `x-access-predicate`
 * (GW_METADATA.ACCESS_PREDICATE, новых ключей не заводим): конверт остаётся
 * base64(JSON) и получает ДОПОЛНИТЕЛЬНОЕ необязательное поле `bySubject`.
 *
 *   { ir: null, mongo: <предикат маршрута|null>, bySubject: { deals: {ir,mongo}, … } }
 *
 * Совместимость: `mongo`/`ir` не меняют смысла, поэтому любой существующий
 * потребитель (`readAccessPredicate`/`parseCompiledPredicate` из shared) читает
 * конверт как раньше и незнакомое поле игнорирует; `bySubject` появляется ТОЛЬКО
 * на агрегатных маршрутах, а их метадата уходит в reports (плюс справочные вызовы
 * control/pipe/audit из того же BFF, которые `bySubject` не читают). Домен reports
 * читает поле через `readAggregateAccessPredicate` и применяет фрагмент источника
 * к своей коллекции — предикатом в БД, не фильтрацией в памяти (INV-4).
 *
 * TODO(owner): поднять `bySubject` в канонический тип `CompiledPredicate`
 * (shared/src/abac/predicate.ts) вместе с ридером — расширение контракта метадаты
 * вне зоны волны «Статистика» (решение владельца).
 */
import {
  compileAccessPredicate,
  hasCondition,
  predicateActionsForRoute,
  ruleTargets,
  type AbacPolicyRule,
  type CompileAccessPredicateArgs,
} from './access-predicate';

/**
 * Источники агрегатов = subject'ы данных, из которых строится ответ статистики.
 * Имена совпадают с `SourceEntity` домена reports (`reports.service.ts`) — это и
 * есть ключ `bySubject`, иначе домен не сопоставит фрагмент с коллекцией.
 */
export const AGGREGATE_SOURCE_SUBJECTS = [
  'deals',
  'orders',
  'contacts',
  'companies',
  'activities',
] as const;

/**
 * Маршрутные subject'ы, чей ответ — агрегат над чужими данными. `reports` включён
 * целиком: run/drill/export читают те же коллекции, а list/get определений отчётов
 * просто не смотрят в `bySubject` (лишний фрагмент в метадате никого не сужает).
 */
export const AGGREGATE_ROUTE_SUBJECTS: ReadonlySet<string> = new Set([
  'statistics',
  'statistics.widget',
  'reports',
]);

export function isAggregateRouteSubject(subject: string): boolean {
  return AGGREGATE_ROUTE_SUBJECTS.has(subject);
}

/**
 * Mongo-фрагмент из уже сериализованного значения `compileAccessPredicate`.
 * Компилируем ИМЕННО через публичную функцию (а не копией её тела), чтобы
 * семантика источников совпадала с семантикой их собственных маршрутов до
 * последней детали: тот же fail-safe (нескомпилируемое правило → предиката нет),
 * тот же разбор read-образных действий, те же нерезолвимые контекстные атрибуты.
 */
function decodeMongo(serialized: string | undefined): Record<string, unknown> | null {
  if (!serialized) return null;
  try {
    const obj = JSON.parse(Buffer.from(serialized, 'base64').toString('utf8')) as {
      mongo?: unknown;
    };
    return obj?.mongo && typeof obj.mongo === 'object' && !Array.isArray(obj.mongo)
      ? (obj.mongo as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Фрагмент «не матчит ни одной записи» для БЕЗУСЛОВНОГО deny на источник.
 *
 * Вторая половина таблицы effect × condition (access-predicate.ts): условный deny —
 * это построчный предикат (`$nor`), а deny БЕЗ условия — сплошной запрет на пару
 * subject:action. На собственном маршруте источника его enforce-ит гейт
 * (`ProjectAccessGuard.isDeniedByPolicy` → 403), но агрегат отвечает по subject'у
 * `statistics`/`reports`, и до появления этого фрагмента проект с правилом
 * `deny activities:read` получал 403 на `/api/v1/activities` и при этом видел в
 * `GET /dashboard` списки overdue/upcoming/recent с id/заголовками/владельцами тех
 * же активностей (а `deny deals:read` — KPI, воронку и записи «зависших» сделок).
 *
 * Форма — обычный mongo-фрагмент, а не спец-флаг: домен уже применяет любой
 * фрагмент источника предикатом В БД (INV-4), поэтому новых полей контракт не
 * заводит, а «пусто» получается в самом запросе, а не фильтрацией в памяти.
 * `{_id: {$in: []}}` не матчит ничего при любом типе `_id` и в любой стадии
 * пайплайна (в отличие от `{$nor: [{}]}`, где пустой документ-условие зависит от
 * версии сервера).
 */
const DENY_ALL_MONGO: Record<string, unknown> = { _id: { $in: [] } };

/** Действия, по которым агрегат читает источник (см. компиляцию ниже — всегда `read`). */
const SOURCE_READ_ACTIONS = predicateActionsForRoute('read');

/**
 * В проекте есть безусловный `deny` на чтение источника → в агрегате он обязан
 * закрыть данные этого источника целиком.
 *
 * Матчинг subject/action/resource берётся из `ruleTargets` — того же теста, что
 * решает, применимо ли ПРАВИЛО к своему маршруту, поэтому «правило про activities»
 * здесь и там значит одно и то же. Отличия от `isDeniedByPolicy` (гейт) — только
 * в сторону строгости: гейт сравнивает `action` буквально и не знает про `*`, а
 * также не смотрит на `resource === subject`. Расхождение (правило `deny deals:*`
 * не даёт 403 на `/api/v1/deals`, хотя закроет сделки в дашборде) — дефект самого
 * гейта: чинить его — менять enforcement на ВСЕХ маршрутах, это решение владельца,
 * а не правка волны «Статистика». Здесь выбран fail-closed.
 */
function hasBlanketReadDeny(rules: AbacPolicyRule[], source: string): boolean {
  return rules.some(
    (rule) =>
      rule != null &&
      rule.effect === 'deny' &&
      !hasCondition(rule) &&
      ruleTargets(rule, source, SOURCE_READ_ACTIONS),
  );
}

/**
 * Значение `x-access-predicate` для агрегатного маршрута: предикат маршрута плюс
 * предикаты источников. `undefined` — когда сужать нечего (заголовок не ставится,
 * поведение ровно как сегодня: projectId + видимость домен применяет всегда).
 *
 * Fail-safety наследуется от `compileAccessPredicate`: если правила источника
 * нескомпилируемы на gateway (нерезолвимый контекст, битое условие), фрагмента для
 * источника просто не будет — и это КОНСИСТЕНТНО с его собственным маршрутом, где
 * предикат по той же причине не поедет (в списке сделок пользователь тоже увидит
 * всё). Расхождение «в списке скрыто, в агрегате видно» устраняется именно этим.
 */
export function compileAggregateAccessPredicate(
  args: CompileAccessPredicateArgs,
): string | undefined {
  const routeMongo = decodeMongo(compileAccessPredicate(args));
  const rules = Array.isArray(args.rules) ? args.rules : [];

  const bySubject: Record<string, { ir: null; mongo: Record<string, unknown> }> = {};
  for (const source of AGGREGATE_SOURCE_SUBJECTS) {
    // Безусловный deny на источник = «этих данных пользователю не видно нигде»,
    // включая агрегат. Проверяется ПЕРВЫМ и перекрывает построчные фрагменты:
    // сплошной запрет строже любого сужения (deny > allow, FR-ABAC-10).
    if (hasBlanketReadDeny(rules, source)) {
      bySubject[source] = { ir: null, mongo: DENY_ALL_MONGO };
      continue;
    }
    // Агрегат ЧИТАЕТ источник — правила берём по действию `read`, независимо от
    // действия маршрута (`/statistics/export` читает те же сделки, что и `/statistics`).
    const mongo = decodeMongo(compileAccessPredicate({ ...args, subject: source, action: 'read' }));
    if (mongo) bySubject[source] = { ir: null, mongo };
  }

  const hasSources = Object.keys(bySubject).length > 0;
  if (!routeMongo && !hasSources) return undefined;
  // Тот же конверт, что у serializeCompiledPredicate (base64(JSON)), плюс bySubject.
  const payload: Record<string, unknown> = { ir: null, mongo: routeMongo };
  if (hasSources) payload.bySubject = bySubject;
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
