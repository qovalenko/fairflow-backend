import { GatewayTimeoutException } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { firstValueFrom, throwError, timeout } from 'rxjs';

const READ_MS = parseInt(process.env.GRPC_DEADLINE_READ_MS ?? '5000', 10);
const WRITE_MS = parseInt(process.env.GRPC_DEADLINE_WRITE_MS ?? '15000', 10);
const DEFAULT_MS = parseInt(process.env.GRPC_DEADLINE_MS ?? String(READ_MS), 10);

/**
 * Доменные таймстемпы хранятся в МС (`Date.now()`), а фронт везде ждёт СЕКУНДЫ
 * (`dayjs.unix`). Конвертим известные timestamp-поля мс→сек на едином выходе BFF —
 * иначе даты улетают в ~58000 год, а «дней на стадии» = огромное отрицательное.
 */
const TS_KEYS = new Set([
  'created_at',
  'updated_at',
  'stage_entered_at',
  'closed_at',
  'expected_close_date',
  'due_date',
  'start_date',
  'end_date',
  'reminder_fire_at',
  'deleted_at',
  'purge_at',
  'last_contact_at',
  'last_activity_at',
  'completed_at',
]);

function isLong(v: unknown): v is { low: number; high: number } {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { low?: unknown }).low === 'number' &&
    typeof (v as { high?: unknown }).high === 'number'
  );
}

/**
 * int64/gRPC Long → plain JS number. protobuf-js decodes int64 as a Long
 * `{low, high, unsigned}` (or a string); BFF response mappers need a bare number
 * for the public JSON contract. Exported so per-controller mappers reuse one
 * canonical coercion instead of each re-rolling its own (T-028).
 */
export function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v) || 0;
  if (isLong(v)) return v.high * 0x1_0000_0000 + (v.low >>> 0);
  return 0;
}

/**
 * Значение timestamp-поля → число, если это ЧИСЛОВАЯ метка (JS number, protobuf
 * Long, либо целочисленная строка — так int64 приходит с `longs: String`).
 * `null` — «это не числовая метка» (ISO-строка из auth/control, null, объект):
 * такое значение вызывающий код обязан пропустить нетронутым.
 */
function numericTimestamp(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (isLong(raw)) return toNum(raw);
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function msTimestampsToSeconds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(msTimestampsToSeconds);
  if (value && typeof value === 'object') {
    // Любой int64, приехавший объектом Long — РАЗВОРАЧИВАЕМ здесь, где бы он ни
    // лежал (`total`, `at`, `succeeded_at`, `size_bytes`, `amount_minor`, …).
    // Раньше тут стояло `return value` с комментарием «фронт умеет» — фронт НЕ
    // умеет: `dayjs.unix({low,high})` = Invalid Date, `Number({low,high})` = NaN.
    // С `longs: Number` в loader'е (grpc-bff.module.ts) сюда Long уже не приходит,
    // ветка остаётся страховкой на случай возврата грабли — но она больше не врёт.
    if (isLong(value)) return toNum(value);
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      if (TS_KEYS.has(k)) {
        const raw = src[k];
        // Числовая метка (number | Long | целочисленная строка от `longs:String`).
        // ISO-строки (auth/control объявляют часть `created_at` как `string`) и
        // null/undefined — НЕ метки в мс: отдаём как есть, не выдумывая нулей.
        const n = numericTimestamp(raw);
        // Порог 1e11: валидных unix-СЕКУНД такой величины не бывает (~5138 год),
        // значит это миллисекунды → делим. Значения ниже порога уже в секундах
        // (напр. expected_close_date ~1.78e9) — делить их нельзя, но наружу они
        // теперь всё равно уходят ЧИСЛОМ, а не сырым Long, как было раньше.
        if (n === null) out[k] = raw;
        else out[k] = n > 1e11 ? Math.floor(n / 1000) : n;
      } else {
        out[k] = msTimestampsToSeconds(src[k]);
      }
    }
    return out;
  }
  return value;
}

/** Per-call deadline on gateway → microservice gRPC (rxjs timeout). */
export async function grpcBffCall<T>(
  source: Observable<T>,
  deadlineMsOrKind: number | 'read' | 'write' = 'read',
): Promise<T> {
  const deadlineMs =
    typeof deadlineMsOrKind === 'number'
      ? deadlineMsOrKind
      : deadlineMsOrKind === 'write'
        ? WRITE_MS
        : READ_MS || DEFAULT_MS;
  const result = await firstValueFrom(
    source.pipe(
      timeout({
        first: deadlineMs,
        // A per-call BFF deadline miss is a gateway→upstream TIMEOUT, so the
        // correct client-facing status is 504 Gateway Timeout (mirrors the
        // gRPC DEADLINE_EXCEEDED→504 mapping in shared/grpc-to-http). Gateway-wide
        // and intentional — previously this raised a misleading 503.
        with: () =>
          throwError(
            () => new GatewayTimeoutException(`Upstream gRPC timed out after ${deadlineMs}ms`),
          ),
      }),
    ),
  );
  return msTimestampsToSeconds(result) as T;
}
