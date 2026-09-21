import { Module } from '@nestjs/common';
import { V1DataBffController } from './v1-data-bff.controller';
import { CrmBffController } from './crm-bff.controller';
import { CommonBffController } from './common-bff.controller';
import { RolesBffController } from './roles-bff.controller';
import { PoliciesBffController } from './policies-bff.controller';
import { StatisticsBffController } from './statistics-bff.controller';
import { ChatBffController } from './chat-bff.controller';
import { SystemAuthBffController } from './system-auth-bff.controller';
import { PublicApiController } from './public-api.controller';
import { ProjectApiKeyGuard } from '../auth/guards/project-api-key.guard';
import { ProjectAccessGuard } from '../guards/project-access.guard';
import { SystemAccessGuard } from '../guards/system-access.guard';
import { SystemOrgContextGuard } from '../guards/system-org-context.guard';
import { NotificationStreamService } from './notification-stream.service';
import { RedisPubSubService } from './redis-pubsub.service';
import { ChatStreamService } from './chat-stream.service';
import { ChatRealtimeAccessService } from './chat-realtime-access.service';
import { ChatAttachmentStorageService } from './chat-attachment-storage.service';
import { DocumentStorageService } from './document-storage.service';
import { OrgLogoStorageService } from './org-logo-storage.service';
import { IdentityResolverService } from './identity-resolver.service';
import { ReportRunNamesService } from './report-run-names.service';
import { AssigneeNameInterceptor } from './assignee-name.interceptor';
import { PolicyImpactService } from './policy-impact.service';
import { PermissionProjectionCacheService } from './permission-projection-cache.service';
import { AuthPublicThrottleGuard } from '../auth/auth-public-throttle.guard';
import { MetricsModule } from '../metrics/metrics.module';

// box (on-prem, §3.2 п.4): billing is a SaaS-only surface that does not exist in
// box — no `BILLING_GRPC` DI token, no billing BFF controller.
//
// TODO-026 (box): the cross-project `org-overview` aggregate is a CLOUD surface —
// box has no «организация» entity, and the contour had no rollup writer at all
// (`OrgRollupStore.applyIncrement` had zero callers), so `/api/v1/system/overview/*`
// could only ever answer empty. Removed from the box delivery together with the
// `ORG_OVERVIEW_GRPC` descriptor, the reports-side domain and its proto package.
const bffControllers = [
  V1DataBffController,
  CrmBffController,
  CommonBffController,
  RolesBffController,
  PoliciesBffController,
  StatisticsBffController,
  ChatBffController,
  SystemAuthBffController,
  // BX-INTEG-2: public read-only project API behind an `ffk_…` key (ProjectApiKeyGuard).
  PublicApiController,
];

@Module({
  imports: [MetricsModule],
  controllers: bffControllers,
  providers: [
    ProjectApiKeyGuard,
    ProjectAccessGuard,
    SystemAccessGuard,
    SystemOrgContextGuard,
    RedisPubSubService,
    NotificationStreamService,
    ChatStreamService,
    ChatRealtimeAccessService,
    ChatAttachmentStorageService,
    DocumentStorageService,
    OrgLogoStorageService,
    IdentityResolverService,
    ReportRunNamesService,
    AssigneeNameInterceptor,
    PermissionProjectionCacheService,
    AuthPublicThrottleGuard,
    PolicyImpactService,
  ],
  // ChatStreamService + ChatRealtimeAccessService are exported so the raw-Fastify WS
  // gateway (chat-ws.gateway.ts) can resolve them from the Nest container during
  // bootstrap — the socket needs both the fanout and its access PEP.
  exports: [ChatStreamService, ChatRealtimeAccessService, RedisPubSubService],
})
export class BffApiModule {}
