import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { from, Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { IdentityResolverService } from './identity-resolver.service';

/** Ограничитель обхода дерева ответа (защита от глубоких/циклических структур). */
const MAX_DEPTH = 8;

/**
 * Заполняет `assigneeName` из `assigneeId` в ответах CRM-контроллеров.
 * Доменные сервисы отдают в assigneeName пусто/сырой UUID; gateway — единственная точка,
 * знающая и запись (assigneeId), и справочник пользователей (auth), поэтому join имени
 * делается здесь централизованно: один interceptor покрывает все списки/детали/вложенные
 * сущности (сделки внутри компании, продажи внутри сделки и т.п.) без правок в каждом
 * эндпоинте. Резолв — батч + кэш; при недоступности auth имя не меняется (fail-soft).
 */
@Injectable()
export class AssigneeNameInterceptor implements NestInterceptor {
  constructor(private readonly identity: IdentityResolverService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: { userId?: string } }>();
    return next.handle().pipe(mergeMap((body) => from(this.enrich(req, body))));
  }

  private async enrich(
    req: FastifyRequest & { user?: { userId?: string } },
    body: unknown,
  ): Promise<unknown> {
    if (!body || typeof body !== 'object') return body;

    const nodes: Record<string, unknown>[] = [];
    collectAssigneeNodes(body, nodes, 0, new Set());
    if (nodes.length === 0) return body;

    const ids = nodes.map((n) => n.assigneeId as string | undefined);
    const nameById = await this.identity.resolveNames(req, ids);
    if (nameById.size === 0) return body;

    for (const n of nodes) {
      const id = n.assigneeId ? String(n.assigneeId) : '';
      const name = id ? nameById.get(id) : undefined;
      if (name) n.assigneeName = name;
    }
    return body;
  }
}

/** Рекурсивно собирает объекты, у которых есть собственное поле `assigneeId`. */
function collectAssigneeNodes(
  value: unknown,
  out: Record<string, unknown>[],
  depth: number,
  seen: Set<unknown>,
): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectAssigneeNodes(item, out, depth + 1, seen);
    return;
  }

  const obj = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, 'assigneeId')) out.push(obj);
  for (const key of Object.keys(obj)) {
    collectAssigneeNodes(obj[key], out, depth + 1, seen);
  }
}
