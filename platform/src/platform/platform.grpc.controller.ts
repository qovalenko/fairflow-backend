import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { resolveProjectId } from '@fairflow/shared';
import { PlatformService } from './platform.service';

@Controller()
export class PlatformGrpcController {
  constructor(private readonly platform: PlatformService) {}

  @GrpcMethod('PlatformGrpc', 'NotificationCount')
  async nCount() {
    return this.platform.notificationCount();
  }

  @GrpcMethod('PlatformGrpc', 'ListNotifications')
  async nList() {
    return this.platform.listNotifications();
  }

  @GrpcMethod('PlatformGrpc', 'Search')
  search(d: { project_id?: string; query: string }, metadata?: Metadata) {
    return this.platform.search(resolveProjectId(metadata, d.project_id), d.query);
  }

  @GrpcMethod('PlatformGrpc', 'AppendAudit')
  audit(d: Record<string, unknown>) {
    return this.platform.appendAudit(d as Parameters<PlatformService['appendAudit']>[0]);
  }

  @GrpcMethod('PlatformGrpc', 'ListAudit')
  listAudit(d: { project_id?: string; page_size?: number }, metadata?: Metadata) {
    return this.platform.listAudit(resolveProjectId(metadata, d.project_id), d.page_size ?? 50);
  }

  @GrpcMethod('PlatformGrpc', 'ListDocumentTemplates')
  docs(d: { project_id?: string }, metadata?: Metadata) {
    return this.platform.listDocumentTemplates(resolveProjectId(metadata, d.project_id));
  }

  @GrpcMethod('PlatformGrpc', 'CheckQuota')
  quota(d: { user_id: string; action: string }) {
    return this.platform.checkQuota(d.user_id, d.action);
  }

  @GrpcMethod('PlatformGrpc', 'CreateUploadUrl')
  upload(d: { bucket: string; object_key: string }) {
    return this.platform.createUploadUrl(d.bucket, d.object_key);
  }

  @GrpcMethod('PlatformGrpc', 'DispatchWebhook')
  webhook(d: { url: string; payload_json: string }) {
    return this.platform.dispatchWebhook(d.url, d.payload_json);
  }
}
