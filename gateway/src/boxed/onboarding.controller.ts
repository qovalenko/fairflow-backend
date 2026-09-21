import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Inject,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UnprocessableEntityException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../common/public.decorator';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';
import { BootstrapStateService } from './bootstrap-state.service';

type ReqLike = FastifyRequest & { user?: { userId?: string } };

interface BootstrapDto {
  email?: string;
  password?: string;
  name?: string;
  organizationName?: string;
  inn?: string;
}

type AuthLoginResponse = Record<string, unknown> & { user?: Record<string, unknown> };

/**
 * BOX-productize Phase E (§5.4): self-hosted master-account bootstrap.
 *
 * `POST /api/bootstrap` is the ONLY way to create the first user of a fresh
 * on-prem instance. It orchestrates auth.Register → control.CreateOrganization
 * in one call, then auto-logs the master admin in (access cookie). Single-shot:
 * - System already exists → 409 ALREADY_INITIALIZED.
 * - FR-ORG-007 partial failure (user without org): idempotent replay by email
 *   verifies the password and completes CreateOrganization.
 * - Race: relies on the DB-unique auth Register (email/login) — the loser's
 *   Register fails with ALREADY_EXISTS → recovery path or 409.
 */
@Controller({ path: '', version: VERSION_NEUTRAL })
export class OnboardingController implements OnModuleInit {
  private static readonly ACCESS_COOKIE = 'ff_access_token';
  private readonly logger = new Logger(OnboardingController.name);

  private authGrpc!: {
    register: (x: unknown, m?: unknown) => unknown;
    login: (x: unknown, m?: unknown) => unknown;
    getUserByEmail: (x: unknown, m?: unknown) => unknown;
  };
  private orgGrpc!: { createOrganization: (x: unknown, m?: unknown) => unknown };

  constructor(
    @Inject('AUTH_GRPC') private readonly authClient: ClientGrpcProxy,
    @Inject('CONTROL_GRPC') private readonly controlClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly bootstrapState: BootstrapStateService,
  ) {}

  onModuleInit() {
    this.authGrpc = this.authClient.getService('AuthGrpc');
    this.orgGrpc = this.controlClient.getService('OrganizationGrpc');
  }

  @Public()
  @Post('bootstrap')
  @ApiTags('Onboarding')
  @ApiOperation({
    summary: 'Create the master account + tenant org of a fresh self-hosted instance',
  })
  async bootstrap(
    @Body() body: BootstrapDto,
    @Req() req: ReqLike,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // Validation.
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    const name = (body.name ?? '').trim();
    const organizationName = (body.organizationName ?? '').trim();
    const inn = (body.inn ?? '').trim();
    if (!email || !this.isEmail(email)) {
      throw new BadRequestException({
        code: 'INVALID_ARGUMENT',
        message: 'valid email is required',
      });
    }
    if (password.length < 8) {
      throw new BadRequestException({
        code: 'INVALID_ARGUMENT',
        message: 'password must be at least 8 characters',
      });
    }
    if (!name) {
      throw new BadRequestException({ code: 'INVALID_ARGUMENT', message: 'name is required' });
    }
    if (!organizationName) {
      throw new BadRequestException({
        code: 'INVALID_ARGUMENT',
        message: 'organizationName is required',
      });
    }
    // FR-AUTH-024: ИНН optional at bootstrap; validate format only when provided.
    if (inn && !/^(\d{10}|\d{12})$/.test(inn)) {
      throw new BadRequestException({
        code: 'INVALID_ARGUMENT',
        message: 'inn must be 10 or 12 digits',
      });
    }

    const md = this.outboundMeta.build(req);

    // Fail-closed once the singleton system org exists (FR-ORG-007). User-only
    // initialization is not enough — partial Register→CreateOrg must replay.
    if (await this.bootstrapState.hasSystem(req)) {
      throw new ConflictException({ code: 'ALREADY_INITIALIZED' });
    }

    const hasUser = await this.bootstrapState.isInitialized(req);
    let authRes: AuthLoginResponse;

    if (!hasUser) {
      // Fresh install: create the master user via the auth domain. Race-safe: under
      // two concurrent bootstraps the DB-unique email/login makes the loser's
      // Register fail with ALREADY_EXISTS → recovery path below.
      try {
        authRes = (await grpcBffCall(
          this.authGrpc.register({ user_name: name, email, password }, md) as never,
        )) as AuthLoginResponse;
      } catch (e) {
        const code = (e as { code?: unknown })?.code;
        if (code === GrpcStatus.ALREADY_EXISTS || code === GrpcStatus.ABORTED) {
          authRes = await this.replayBootstrapByEmail(req, email, password);
        } else {
          throw new BadRequestException(this.grpcMessage(e, 'Registration failed'));
        }
      }
    } else {
      // FR-ORG-007: user exists but org creation previously failed — replay by email.
      authRes = await this.replayBootstrapByEmail(req, email, password);
    }

    const user = (authRes.user ?? {}) as Record<string, unknown>;
    const userId = typeof user.id === 'string' ? user.id : '';
    if (!userId) throw new InternalServerErrorException('Registration returned no user id');
    // Latch user-exists *before* CreateOrganization so a partial failure cannot
    // leave the 30s negative cache open for a second email (FR-ORG-007).
    this.bootstrapState.markUserExists();

    // Create the tenant organization. control.CreateOrganization also inserts
    // the owner Employee (role platform_owner) in the same tx.
    let org: Record<string, unknown>;
    try {
      org = (await grpcBffCall(
        this.orgGrpc.createOrganization(
          {
            name: organizationName,
            slug: this.slugify(organizationName),
            user_id: userId,
            inn: inn || undefined,
          },
          md,
        ) as never,
      )) as Record<string, unknown>;
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      if (code === GrpcStatus.ALREADY_EXISTS) {
        throw new ConflictException({ code: 'ALREADY_INITIALIZED' });
      }
      this.logger.error(
        `bootstrap: master user=${userId} created but CreateOrganization failed: ${this.grpcMessage(
          e,
          'unknown',
        )}. Retry bootstrap with the same email to finish setup.`,
      );
      // 422, not 500: AppErrorFilter drops semantic codes on 5xx (`status < 500`),
      // so ORG_CREATE_FAILED would become INTERNAL and the BootstrapForm branch
      // would never fire. Not 409 either — the form treats any 409 as
      // ALREADY_INITIALIZED and navigates away from retry.
      throw new UnprocessableEntityException({
        code: 'ORG_CREATE_FAILED',
        message:
          'Master user created but organization setup failed. Retry bootstrap with the same email or sign in and finish setup.',
      });
    }

    // Auto-login: set the access cookie exactly like auth.register does.
    const token = this.accessToken(authRes);
    this.setAccessCookie(reply, token, this.expiresIn(authRes));

    this.bootstrapState.markInitialized();

    this.logger.log(`instance bootstrapped: master user=${userId} org=${String(org.id ?? '')}`);
    return {
      token,
      user: {
        userId,
        userName: typeof user.login === 'string' ? user.login : name,
        email: typeof user.email === 'string' ? user.email : email,
        name: typeof user.name === 'string' ? user.name : name,
        emailVerified: true,
      },
      organization: {
        id: typeof org.id === 'string' ? org.id : '',
        name: typeof org.name === 'string' ? org.name : organizationName,
      },
    };
  }

  /**
   * FR-ORG-007: idempotent bootstrap replay — verify the orphan master account
   * by email+password, then complete CreateOrganization on the next submit.
   */
  private async replayBootstrapByEmail(
    req: ReqLike,
    email: string,
    password: string,
  ): Promise<AuthLoginResponse> {
    const md = this.outboundMeta.build(req);
    const lookup = (await grpcBffCall(this.authGrpc.getUserByEmail({ email }, md) as never)) as {
      found?: boolean;
      user?: { id?: string };
    };
    if (!lookup?.found || !lookup.user?.id) {
      throw new ConflictException({ code: 'ALREADY_INITIALIZED' });
    }
    try {
      return (await grpcBffCall(
        this.authGrpc.login({ identifier: email, password }, md) as never,
      )) as AuthLoginResponse;
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      if (code === GrpcStatus.UNAUTHENTICATED || code === GrpcStatus.PERMISSION_DENIED) {
        throw new UnauthorizedException({
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        });
      }
      throw new BadRequestException(this.grpcMessage(e, 'Login failed'));
    }
  }

  private isEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  private slugify(name: string): string {
    const base = name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    // control enforces uniqueness; add a short suffix to reduce collision odds.
    const suffix = Math.random().toString(36).slice(2, 8);
    return base ? `${base}-${suffix}` : `org-${suffix}`;
  }

  private accessToken(res: Record<string, unknown>): string {
    const t = res.access_token ?? res.accessToken;
    return typeof t === 'string' ? t : '';
  }

  private expiresIn(res: Record<string, unknown>): string | undefined {
    const v = res.expires_in ?? res.expiresIn;
    return typeof v === 'string' ? v : undefined;
  }

  private setAccessCookie(reply: FastifyReply, token: string, expiresIn?: string): void {
    const maxAge = this.maxAgeFromExpiresIn(expiresIn ?? process.env.JWT_EXPIRE ?? '24h');
    reply.header(
      'Set-Cookie',
      `${OnboardingController.ACCESS_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
        process.env.NODE_ENV === 'production' ? '; Secure' : ''
      }`,
    );
  }

  private maxAgeFromExpiresIn(s: string): number {
    const m = s.match(/^(\d+)(d|h|m|s)?$/);
    if (!m) return 24 * 60 * 60;
    const n = parseInt(m[1], 10);
    const unit = m[2] ?? 's';
    if (unit === 'd') return n * 24 * 60 * 60;
    if (unit === 'h') return n * 60 * 60;
    if (unit === 'm') return n * 60;
    return n;
  }

  private grpcMessage(e: unknown, fallback: string): string {
    const msg =
      (e as { details?: string; message?: string })?.details ??
      (e as { message?: string })?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
