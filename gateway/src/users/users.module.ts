import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { SystemAccessGuard } from '../guards/system-access.guard';
import { SystemOrgContextGuard } from '../guards/system-org-context.guard';

@Module({
  controllers: [UsersController],
  providers: [UsersService, SystemAccessGuard, SystemOrgContextGuard],
  exports: [UsersService],
})
export class UsersModule {}
