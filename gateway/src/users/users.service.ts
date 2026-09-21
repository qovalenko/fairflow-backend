import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';
import type { UsersListResult } from './user.model';

export interface FindManyUsersOptions {
  skip?: number;
  take?: number;
  login?: string;
  isActive?: boolean;
}

type GrpcReq = FastifyRequest & { user?: { userId?: string; sessionId?: string } };

@Injectable()
export class UsersService implements OnModuleInit {
  private authGrpc!: {
    listUsers: (x: unknown, m?: unknown) => import('rxjs').Observable<Record<string, unknown>>;
  };

  constructor(
    @Inject('AUTH_GRPC') private readonly authClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  onModuleInit() {
    this.authGrpc = this.authClient.getService('AuthGrpc');
  }

  async findMany(req: GrpcReq, options: FindManyUsersOptions): Promise<UsersListResult> {
    const { skip = 0, take = 25, login, isActive } = options;
    const md = this.outboundMeta.build(req);
    const raw = (await grpcBffCall(
      this.authGrpc.listUsers(
        {
          skip,
          take: Math.min(take, 100),
          login_filter: login ?? '',
          ...(isActive !== undefined && { is_active: isActive }),
        },
        md,
      ) as never,
    )) as {
      list?: Record<string, unknown>[];
      total?: number;
    };
    const list = raw.list ?? [];
    return {
      list: list.map((u) => ({
        id: String(u.id ?? ''),
        login: String(u.login ?? ''),
        email: String(u.email ?? ''),
        name: u.name != null ? String(u.name) : null,
        isActive: Boolean(u.is_active ?? u.isActive),
        createdAt: new Date(String(u.created_at ?? u.createdAt ?? Date.now())),
      })),
      total: Number(raw.total ?? 0),
    };
  }
}
