import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SystemAccessGuard } from '../guards/system-access.guard';
import { SystemOrgContextGuard } from '../guards/system-org-context.guard';
import { RequireSystemRole } from '../guards/require-system-role.decorator';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard, SystemOrgContextGuard, SystemAccessGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequireSystemRole('manage')
  @ApiOperation({ summary: 'List users (system manage only)' })
  async list(
    @Req() req: FastifyRequest & { user?: { userId?: string; sessionId?: string } },
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('login') login?: string,
    @Query('isActive') isActive?: string,
  ) {
    const result = await this.users.findMany(req, {
      skip: skip ? parseInt(skip, 10) : 0,
      take: take ? Math.min(parseInt(take, 10), 100) : 25,
      login: login ?? undefined,
      isActive: isActive === 'true' ? true : isActive === 'false' ? false : undefined,
    });
    return result;
  }
}
