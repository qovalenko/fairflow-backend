import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvisioningModule } from '../provisioning/provisioning.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectsService } from './projects.service';
import { ModuleDisableImpactService } from './module-disable-impact.service';
import { ModuleLifecycleService } from './module-lifecycle.service';
import { ProjectAccessEpochService } from './project-access-epoch.service';
import { ProjectPurgeService } from './project-purge.service';
import { MutationIdempotencyService } from '../idempotency/mutation-idempotency.service';

import { MemberOwnedRecordsModule } from './member-owned-records.module';
import { ProjectInvitationsService } from './project-invitations.service';

@Module({
  imports: [PrismaModule, ProvisioningModule, OutboxModule, MemberOwnedRecordsModule],
  providers: [
    MutationIdempotencyService,
    ProjectsService,
    ModuleDisableImpactService,
    ModuleLifecycleService,
    ProjectAccessEpochService,
    ProjectPurgeService,
    ProjectInvitationsService,
  ],
  exports: [
    ProjectsService,
    ModuleDisableImpactService,
    ModuleLifecycleService,
    ProjectAccessEpochService,
    ProjectPurgeService,
    ProjectInvitationsService,
  ],
})
export class ProjectsModule {}
