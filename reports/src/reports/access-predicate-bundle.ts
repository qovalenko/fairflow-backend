/**
 * Чтение ABAC-предиката для АГРЕГАТОВ (статистика/дашборд/отчёты).
 *
 * Маршрутный предикат (`x-access-predicate` → `readAccessPredicate`) скомпилирован
 * gateway по subject'у маршрута — `statistics`/`reports`. Ответ же собирается из
 * пяти чужих коллекций, поэтому gateway кладёт в тот же конверт ещё и предикаты по
 * subject'ам-ИСТОЧНИКАМ (`gateway/src/guards/access-predicate.aggregate.ts`):
 *
 *   { ir: null, mongo: <маршрутный|null>, bySubject: { deals: {ir,mongo}, … } }
 *
 * Здесь конверт разбирается в ту же трёхсостоянийную форму `AccessPredicate`, что
 * и маршрутный предикат, но отдельно для каждого источника. Ключ метадаты — прежний
 * (`GW_METADATA.ACCESS_PREDICATE`), новых ключей контракт не заводит; отсутствие
 * `bySubject` = старое поведение (сужает только маршрутный предикат).
 *
 * Fail-closed так же, как у `readAccessPredicate`: конверт передан, но `bySubject`
 * или его элемент нечитаемы → это сломанное deny-правило, и источник обязан отдать
 * deny-all, а не «расшириться» до полного доступа.
 */
import type { Metadata } from '@grpc/grpc-js';
import {
  GW_METADATA,
  readAccessPredicate,
  readGatewayMetadata,
  type AccessPredicate,
} from '@fairflow/shared';

/**
 * Маршрутный предикат + предикаты источников. Расширяет (а не заменяет) контрактный
 * `AccessPredicate`, поэтому всё, что умело работать с маршрутным предикатом,
 * продолжает работать без изменений.
 */
export type AggregateAccessPredicate = AccessPredicate & {
  /** subject источника (`deals`/`orders`/…) → его предикат. Нет ключа = не сужаем. */
  bySubject?: Record<string, AccessPredicate>;
  /** `bySubject` прислан, но нечитаем → каждый источник отвечает deny-all. */
  bySubjectMalformed?: boolean;
};

/** Один элемент `bySubject` → трёхсостоянийный предикат (как readAccessPredicate). */
function toPredicate(value: unknown): AccessPredicate {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { present: true, malformed: true };
  }
  const mongo = (value as { mongo?: unknown }).mongo;
  // `mongo: null` — «правил для источника нет» (gateway такой элемент не шлёт,
  // но читать его как «не сужаем» безопаснее, чем как поломку).
  if (mongo == null) return { present: false };
  if (typeof mongo !== 'object' || Array.isArray(mongo)) return { present: true, malformed: true };
  return { present: true, mongo: mongo as Record<string, unknown>, ir: null };
}

export function readAggregateAccessPredicate(metadata?: Metadata): AggregateAccessPredicate {
  const route = readAccessPredicate(metadata);
  const raw = readGatewayMetadata(metadata, GW_METADATA.ACCESS_PREDICATE).trim();
  if (!raw) return route;

  let envelope: { bySubject?: unknown } | null;
  try {
    envelope = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as { bySubject?: unknown };
  } catch {
    // Конверт нечитаем целиком — `route` здесь уже malformed (deny-all), и этого
    // достаточно: маршрутный фрагмент применяется ко всем источникам.
    return route;
  }
  if (envelope == null || typeof envelope !== 'object') return route;
  if (envelope.bySubject == null) return route;
  if (typeof envelope.bySubject !== 'object' || Array.isArray(envelope.bySubject)) {
    return { ...route, bySubjectMalformed: true };
  }

  const bySubject: Record<string, AccessPredicate> = {};
  for (const [subject, value] of Object.entries(envelope.bySubject as Record<string, unknown>)) {
    bySubject[subject] = toPredicate(value);
  }
  return { ...route, bySubject };
}
