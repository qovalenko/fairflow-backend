import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  ConflictException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

jest.mock('../bff/grpc-bff-call', () => ({
  grpcBffCall: jest.fn(async (obs: unknown) => {
    if (obs && typeof (obs as { then?: unknown }).then === 'function') {
      return obs;
    }
    if (typeof obs === 'function') {
      return (obs as () => unknown)();
    }
    return obs;
  }),
}));

import { grpcBffCall } from '../bff/grpc-bff-call';
import { OnboardingController } from './onboarding.controller';
import type { BootstrapStateService } from './bootstrap-state.service';
import type { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';

/**
 * FR-ORG-007: bootstrap idempotent replay by email when user exists but org is missing.
 */
describe('OnboardingController.bootstrap — FR-ORG-007 replay', () => {
  const req = { headers: {} } as never;
  const reply = { header: jest.fn() } as never;
  const grpcBffCallMock = grpcBffCall as jest.Mock;

  const body = {
    email: 'admin@example.com',
    password: 'password123',
    name: 'Admin',
    organizationName: 'Acme',
    inn: '1234567890',
  };

  beforeEach(() => {
    grpcBffCallMock.mockReset();
    grpcBffCallMock.mockImplementation(async (obs: unknown) => obs);
  });

  function makeController(deps: { hasSystem: boolean; hasUser: boolean }) {
    const authGrpc = {
      register: jest.fn(),
      getUserByEmail: jest.fn(),
      login: jest.fn(),
    };
    const orgGrpc = {
      createOrganization: jest.fn(),
    };
    const bootstrapState = {
      hasSystem: jest.fn().mockResolvedValue(deps.hasSystem),
      isInitialized: jest.fn().mockResolvedValue(deps.hasUser),
      markInitialized: jest.fn(),
      markUserExists: jest.fn(),
    };

    const controller = new OnboardingController(
      { getService: () => authGrpc } as never,
      { getService: () => orgGrpc } as never,
      { build: () => ({}) } as unknown as GatewayOutboundMetadataService,
      bootstrapState as unknown as BootstrapStateService,
    );
    controller.onModuleInit();
    return { controller, authGrpc, orgGrpc, bootstrapState };
  }

  it('replays bootstrap by email when user exists but system org is missing', async () => {
    const { controller, authGrpc, orgGrpc } = makeController({
      hasSystem: false,
      hasUser: true,
    });

    authGrpc.getUserByEmail.mockReturnValue({ found: true, user: { id: 'user-1' } });
    authGrpc.login.mockReturnValue({
      access_token: 'tok',
      expires_in: '24h',
      user: { id: 'user-1', email: 'admin@example.com', login: 'Admin' },
    });
    orgGrpc.createOrganization.mockReturnValue({ id: 'org-1', name: 'Acme' });

    const result = await controller.bootstrap(body, req, reply);

    expect(authGrpc.getUserByEmail).toHaveBeenCalledWith(
      { email: 'admin@example.com' },
      expect.anything(),
    );
    expect(authGrpc.login).toHaveBeenCalledWith(
      { identifier: 'admin@example.com', password: 'password123' },
      expect.anything(),
    );
    expect(authGrpc.register).not.toHaveBeenCalled();
    expect(orgGrpc.createOrganization).toHaveBeenCalled();
    expect(result.organization).toEqual({ id: 'org-1', name: 'Acme' });
  });

  it('rejects replay with wrong password', async () => {
    const { controller, authGrpc } = makeController({
      hasSystem: false,
      hasUser: true,
    });

    authGrpc.getUserByEmail.mockReturnValue({ found: true, user: { id: 'user-1' } });
    authGrpc.login.mockImplementation(() => {
      throw { code: GrpcStatus.UNAUTHENTICATED };
    });

    await expect(controller.bootstrap(body, req, reply)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when system org already exists', async () => {
    const { controller } = makeController({ hasSystem: true, hasUser: true });
    await expect(controller.bootstrap(body, req, reply)).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts bootstrap without inn (FR-AUTH-024)', async () => {
    const { controller, authGrpc, orgGrpc } = makeController({
      hasSystem: false,
      hasUser: false,
    });
    authGrpc.register.mockReturnValue({
      access_token: 'tok',
      user: { id: 'user-1', email: 'admin@example.com' },
    });
    orgGrpc.createOrganization.mockReturnValue({ id: 'org-1', name: 'Acme' });

    const { inn: _omit, ...withoutInn } = body;
    await controller.bootstrap(withoutInn, req, reply);

    expect(orgGrpc.createOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ inn: undefined }),
      expect.anything(),
    );
  });

  it('rejects malformed inn when provided (FR-AUTH-024)', async () => {
    const { controller } = makeController({ hasSystem: false, hasUser: false });
    await expect(controller.bootstrap({ ...body, inn: '123' }, req, reply)).rejects.toMatchObject({
      response: { message: 'inn must be 10 or 12 digits' },
    });
  });

  it('surfaces ORG_CREATE_FAILED as 422 so the FE retry branch can fire', async () => {
    const { controller, authGrpc, orgGrpc, bootstrapState } = makeController({
      hasSystem: false,
      hasUser: true,
    });
    authGrpc.getUserByEmail.mockReturnValue({ found: true, user: { id: 'user-1' } });
    authGrpc.login.mockReturnValue({
      access_token: 'tok',
      user: { id: 'user-1' },
    });
    orgGrpc.createOrganization.mockImplementation(() => {
      throw { code: GrpcStatus.INTERNAL, details: 'db down' };
    });

    try {
      await controller.bootstrap(body, req, reply);
      throw new Error('expected ORG_CREATE_FAILED');
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect((e as UnprocessableEntityException).getStatus()).toBe(422);
      expect((e as UnprocessableEntityException).getResponse()).toMatchObject({
        code: 'ORG_CREATE_FAILED',
      });
    }
    // Partial failure still latches user-exists so a second email cannot register.
    expect(bootstrapState.markUserExists).toHaveBeenCalled();
    expect(bootstrapState.markInitialized).not.toHaveBeenCalled();
  });
});
