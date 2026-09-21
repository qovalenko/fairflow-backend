import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Конвертирует ключи gRPC-ответов в snake_case.
 *
 * Домен (ChatService) исторически собирает view-объекты в camelCase
 * (`senderId`, `userId`, `sentAt`, `myRole`, `lastMessageAt`…), но gRPC-лоадер
 * настроен с `keepCase: true` (нужно, чтобы контроллеры читали ВХОДЯЩИЕ snake-поля,
 * см. main.ts). При сериализации ОТВЕТА keepCase ищет в объекте ровно snake-имена
 * proto-полей — camelCase-ключи (multi-word) не находятся и молча выпадают. Из-за
 * этого FE не получал `sender_id` (нет выравнивания свой/чужой), `user_id`
 * участников (DM показывался как «Личный») и кучу метаданных.
 *
 * Интерцептор маппит только ОТВЕТ (входящие данные уже распарсены до хендлера),
 * поэтому безопасен: приводит ключи к snake — ровно к тому, что ждёт сериализатор
 * и читает gateway-BFF.
 */
function toSnakeKey(k: string): string {
  return k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function snakeDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeDeep);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[toSnakeKey(k)] = snakeDeep(v);
    }
    return out;
  }
  return value;
}

@Injectable()
export class SnakeCaseResponseInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => snakeDeep(data)));
  }
}
