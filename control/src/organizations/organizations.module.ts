import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectsModule } from '../projects/projects.module';
import { UserDirectoryModule } from '../user-directory/user-directory.module';
import { OrganizationsService } from './organizations.service';
import { OrgStructureService } from './org-structure.service';
import { OrgAuditService } from './org-audit.service';
import { InvitationService } from './invitations.service';
import { VisibilityResolverService } from './visibility-resolver.service';
import { RecordSharesService } from './record-shares.service';
import { AccessUnitService } from './access-unit.service';
import { SeatsService } from './seats.service';
import { OrgPdpService } from './org-pdp.service';
import { DepartmentBindingsService } from './department-bindings.service';

// box (on-prem, 03-ARCHITECTURE.md §6): the billing plane is not deployed, so no
// BILLING_GRPC client is registered — SeatsService is unconditionally unlimited.
@Module({
  imports: [
    PrismaModule,
    OutboxModule,
    // ProjectAccessEpochService (FR-MORG-31): binding mutations invalidate the
    // gateway's per-project permission cache for the affected project.
    ProjectsModule,
    // Org-deactivation cascade: OrganizationsService.setActive(false) revokes the
    // members' auth sessions via UserDirectoryService.revokeSessions (fail-soft).
    UserDirectoryModule,
  ],
  providers: [
    OrganizationsService,
    OrgStructureService,
    OrgAuditService,
    InvitationService,
    VisibilityResolverService,
    RecordSharesService,
    AccessUnitService,
    SeatsService,
    OrgPdpService,
    DepartmentBindingsService,
  ],
  exports: [
    OrganizationsService,
    OrgStructureService,
    OrgAuditService,
    InvitationService,
    VisibilityResolverService,
    RecordSharesService,
    AccessUnitService,
    SeatsService,
    OrgPdpService,
    DepartmentBindingsService,
  ],
})
export class OrganizationsModule {}
