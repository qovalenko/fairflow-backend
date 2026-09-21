import { UnprocessableEntityException } from '@nestjs/common';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { AppErrorFilter } from './app-error.filter';

/**
 * FR-ORG-380: domain ROLE_IN_USE must surface as HTTP 409 with semantic code.
 */
describe('AppErrorFilter — ROLE_IN_USE (FR-ORG-380)', () => {
  it('maps gRPC conflict details.code ROLE_IN_USE to HTTP 409', () => {
    const sent = {} as { status: number; body: Record<string, unknown> };
    const reply = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      send(body: Record<string, unknown>) {
        sent.body = body;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({ headers: {}, url: '/api/x', method: 'DELETE' }),
      }),
    };
    const metadata = {
      get: (key: string) =>
        key === GW_METADATA.ERROR_DETAILS
          ? [Buffer.from(JSON.stringify({ code: 'ROLE_IN_USE' }))]
          : undefined,
    };
    new AppErrorFilter().catch(
      {
        code: GrpcStatus.ALREADY_EXISTS,
        details: 'Role is assigned and cannot be deleted',
        metadata,
        message: 'Role is assigned and cannot be deleted',
      },
      host as never,
    );

    expect(sent.status).toBe(409);
    expect(sent.body.code).toBe('ROLE_IN_USE');
    expect((sent.body.error as { code: string }).code).toBe('ROLE_IN_USE');
  });
});

/**
 * FR-ORG-007: 500 would strip the semantic code (`status < 500` guard) and the
 * BootstrapForm `ORG_CREATE_FAILED` branch would never run. 422 keeps it.
 */
describe('AppErrorFilter — ORG_CREATE_FAILED (FR-ORG-007)', () => {
  it('preserves ORG_CREATE_FAILED from a 422 HttpException', () => {
    const sent = {} as { status: number; body: Record<string, unknown> };
    const reply = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      send(body: Record<string, unknown>) {
        sent.body = body;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({ headers: {}, url: '/api/bootstrap', method: 'POST' }),
      }),
    };
    new AppErrorFilter().catch(
      new UnprocessableEntityException({
        code: 'ORG_CREATE_FAILED',
        message: 'retry with the same email',
      }),
      host as never,
    );

    expect(sent.status).toBe(422);
    expect(sent.body.code).toBe('ORG_CREATE_FAILED');
    expect((sent.body.error as { code: string }).code).toBe('ORG_CREATE_FAILED');
  });
});
