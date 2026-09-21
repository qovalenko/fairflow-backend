import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectsModule } from '../projects/projects.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OutboxModule } from '../outbox/outbox.module';
import { RolesService } from './roles.service';
import { PdpService } from './pdp.service';
import { RoleAssignmentExpiryService } from './role-assignment-expiry.service';

@Module({
  imports: [PrismaModule, ProjectsModule, OrganizationsModule, OutboxModule],
  providers: [RolesService, PdpService, RoleAssignmentExpiryService],
  exports: [RolesService, PdpService, RoleAssignmentExpiryService],
})
export class RolesModule {}
