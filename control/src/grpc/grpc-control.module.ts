import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UserDirectoryModule } from '../user-directory/user-directory.module';
import { RolesModule } from '../roles/roles.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AuthValidationModule } from '../auth-validation/auth-validation.module';
import { ControlGrpcController } from './control.grpc.controller';

@Module({
  imports: [
    AuthValidationModule,
    ProjectsModule,
    OrganizationsModule,
    UserDirectoryModule,
    RolesModule,
    IntegrationsModule,
  ],
  controllers: [ControlGrpcController],
})
export class GrpcControlModule {}
