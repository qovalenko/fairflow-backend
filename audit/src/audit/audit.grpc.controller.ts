import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import {
  GW_METADATA,
  readGatewayMetadata,
  readUserId,
  resolveProjectId,
} from '@fairflow/shared';
import { AuditService } from './audit.service';

// Trusted x-project-id metadata wins over the body; a conflicting body projectId
// is rejected. Metadata absent (s2s/internal) → body value (AS-IS fallback).
function pid(d: { project_id?: string; projectId?: string }, metadata?: Metadata): string {
  return resolveProjectId(metadata, d.project_id ?? d.projectId);
}

/**
 * Канон актора (FR-EVT-3/M-9, контракт audit.md §1): actorId/actorType берутся из
 * проверенной gateway-метадаты. Значение из тела honored только как fallback для
 * s2s/internal-вызовов без метадаты — иначе вызывающий положил бы в append-only
 * журнал запись от чужого имени или «от системы» (actor-spoofing).
 */
function actor(
  d: { actor_id?: string; actor_type?: string },
  metadata?: Metadata,
): { actor_id: string; actor_type: string } {
  const userId = readUserId(metadata);
  const actorType = readGatewayMetadata(metadata, GW_METADATA.ACTOR_TYPE).trim();
  return {
    actor_id: userId || (d.actor_id ?? '').trim(),
    actor_type: actorType || (d.actor_type ?? '').trim(),
  };
}

/**
 * TODO-124 (FR-EVT-330 / FR-EVT-370): у контроллера НЕТ `@RequireModule('audit')`.
 *
 * Аудит — сквозная платформенная функция (append-only журнал, доказательная база
 * 152-ФЗ), а не подключаемый в проекте модуль: `audit` нигде не заводится как
 * moduleId (в `MODULE_REGISTRY` его нет, в `routing-keys` `audit` — имя
 * СЕРВИСА-консьюмера событий, другое пространство имён). Декоратор при этом
 * висел: `ProjectAccessGuard` проставляет `x-enabled-modules` на всех
 * project-scoped маршрутах, `ModuleGuard` видел непустой список без `audit` и
 * бросал PERMISSION_DENIED на ЛЮБОЙ вызов с гейта — ломались и запись, и чтение
 * (`/v1/contacts/:id/history`, `/v1/companies/:id/history`,
 * `/v1/orders/:id/history`).
 *
 * Почему сняли декоратор, а не завели `audit` как locked-модуль в реестре:
 * locked-модуль всегда попадает в enabled (`ensureLockedModules`), т.е. гейт
 * стал бы вечным no-op — нулевой выигрыш в защите, зато `audit` протёк бы в
 * каталог прав, манифесты, lifecycle install/uninstall и в UI модулей проекта,
 * подразумевая «журнал можно отключить/удалить», что противоречит append-only.
 *
 * Что осталось гейтом (защита не ослаблена):
 *  - вход в домен: `GrpcInboundApiKeyGuard` (service-API-key), JWT сюда не ходит;
 *  - граница данных: `resolveProjectId` — доверенный `x-project-id` из метадаты
 *    выигрывает у тела;
 *  - модульный/пермишен-гейт по СУЩНОСТИ — на gateway: history-ручки висят под
 *    `@RequireModule('orders' | 'contacts' | 'companies')` + `@RequirePermission`
 *    и делают Get<Entity> ПЕРЕД чтением ленты (гейт чтения истории = гейт чтения
 *    записи). Выключенный модуль продаж по-прежнему закрывает историю продажи —
 *    на своём, корректном уровне.
 */
@Controller()
export class AuditGrpcController {
  constructor(private readonly audit: AuditService) {}

  @GrpcMethod('AuditGrpc', 'AppendEvent')
  appendEvent(d: {
    project_id?: string;
    projectId?: string;
    event_name?: string;
    entity_type?: string;
    entity_id?: string;
    actor_id?: string;
    actor_type?: string;
    payload_json?: string;
    request_id?: string;
    trace_id?: string;
  }, metadata?: Metadata) {
    return this.audit.appendEvent(pid(d, metadata), { ...d, ...actor(d, metadata) });
  }

  @GrpcMethod('AuditGrpc', 'ListEvents')
  listEvents(d: {
    project_id?: string;
    projectId?: string;
    page_index?: number;
    page_size?: number;
    entity_type?: string;
    entity_id?: string;
  }, metadata?: Metadata) {
    return this.audit.listEvents(pid(d, metadata), d.page_index ?? 0, d.page_size ?? 25, d.entity_type, d.entity_id);
  }

  @GrpcMethod('AuditGrpc', 'GetEvent')
  getEvent(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.audit.getEvent(pid(d, metadata), d.id);
  }

  @GrpcMethod('AuditGrpc', 'VerifyAuditChain')
  async verifyAuditChain(d: {
    level?: string;
    organization_id?: string;
    organizationId?: string;
    project_id?: string;
    projectId?: string;
  }, metadata?: Metadata) {
    const result = await this.audit.verifyChain({
      level: d.level,
      organizationId: d.organization_id ?? d.organizationId,
      projectId: resolveProjectId(metadata, d.project_id ?? d.projectId) || undefined,
    });
    return {
      chain_key: result.chainKey,
      status: result.status,
      checked: result.checked,
      broken_at: result.brokenAt
        ? {
            seq: result.brokenAt.seq,
            expected_hash: result.brokenAt.expectedHash,
            actual_hash: result.brokenAt.actualHash,
            reason: result.brokenAt.reason,
          }
        : undefined,
      verified_at: Date.now(),
    };
  }
}
