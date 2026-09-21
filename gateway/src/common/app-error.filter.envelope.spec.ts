/**
 * [be-p0-error-envelope] the HTTP error envelope must carry BOTH shapes:
 *  - flat `{ code, message, details, requestId }` (existing readers:
 *    AssignmentsTab, AbacEditor, BootstrapForm, RolesEditor);
 *  - nested `error: { code, message, details }` — the shape ~10 FE modules
 *    actually read (`response.data.error.code`: reports `isModuleDisabledError`,
 *    notifications `notificationErrorCode`, orders/products/companies/activities,
 *    Members, ImportWizard, Settings, ChatService). It never existed, so every
 *    code-specific branch was dead and users saw the generic error state.
 *
 * It must also PRESERVE the explicit semantic code a guard/handler set
 * (MODULE_DISABLED, POLICY_NOT_COMPILABLE, ALREADY_INITIALIZED …) instead of
 * overwriting it with the status-derived one.
 */
import {
  ForbiddenException,
  UnprocessableEntityException,
  NotFoundException,
} from '@nestjs/common';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { AppErrorFilter } from './app-error.filter';

type Sent = { status: number; body: Record<string, unknown> };

function run(exception: unknown): Sent {
  const sent = {} as Sent;
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
      getRequest: () => ({ headers: { 'x-request-id': 'rid-1' }, url: '/api/x', method: 'GET' }),
    }),
  };
  new AppErrorFilter().catch(exception, host as never);
  return sent;
}

describe('[be-p0-error-envelope] AppErrorFilter envelope', () => {
  it('emits the nested error{} alongside the flat fields', () => {
    const sent = run(new NotFoundException('Документ не найден'));

    expect(sent.status).toBe(404);
    expect(sent.body).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Документ не найден',
      details: null,
      requestId: 'rid-1',
      error: { code: 'NOT_FOUND', message: 'Документ не найден', details: null },
    });
  });

  it('keeps FAILED_PRECONDITION readable at error.code (reports «модуль-источник выключен»)', () => {
    const sent = run(new UnprocessableEntityException({ message: 'source module disabled' }));

    expect(sent.status).toBe(422);
    expect((sent.body.error as { code: string }).code).toBe('FAILED_PRECONDITION');
  });

  it('preserves an explicit guard code (MODULE_DISABLED) in both shapes', () => {
    const sent = run(
      new ForbiddenException({
        code: 'MODULE_DISABLED',
        module: 'reports',
        message: 'Module "reports" is disabled for this project',
      }),
    );

    expect(sent.status).toBe(403);
    expect(sent.body.code).toBe('MODULE_DISABLED');
    expect((sent.body.error as { code: string }).code).toBe('MODULE_DISABLED');
  });

  it('does not leak an internal code/message from a 5xx', () => {
    const sent = run(new Error('connect ECONNREFUSED 10.0.0.5:5001'));

    expect(sent.status).toBe(500);
    expect(sent.body.message).toBe('Internal error');
    expect(sent.body.code).toBe('INTERNAL');
    expect((sent.body.error as { message: string }).message).toBe('Internal error');
  });

  it('surfaces domain validation details on both shapes', () => {
    const sent = run(
      new UnprocessableEntityException({
        message: 'invalid',
        details: [{ field: 'name', code: 'required' }],
      }),
    );

    expect(sent.body.details).toEqual([{ field: 'name', code: 'required' }]);
    expect((sent.body.error as { details: unknown }).details).toEqual([
      { field: 'name', code: 'required' },
    ]);
  });

  it('promotes a domain machine-code gRPC details string to envelope.code', () => {
    const sent = run({
      code: GrpcStatus.ABORTED,
      details: 'TWO_FACTOR_REQUIRED_BY_POLICY',
      message: 'TWO_FACTOR_REQUIRED_BY_POLICY',
    });

    expect(sent.status).toBe(409);
    expect(sent.body.code).toBe('TWO_FACTOR_REQUIRED_BY_POLICY');
    expect((sent.body.error as { code: string }).code).toBe('TWO_FACTOR_REQUIRED_BY_POLICY');
  });

  it('does not overwrite TEMPLATE_INVALID with a machine-code details string', () => {
    const metadata = {
      get: (key: string) =>
        key === GW_METADATA.ERROR_DETAILS
          ? [Buffer.from(JSON.stringify({ code: 'TEMPLATE_INVALID', reason: 'vba' }))]
          : undefined,
    };
    const sent = run({
      code: GrpcStatus.INVALID_ARGUMENT,
      details: 'TWO_FACTOR_REQUIRED_BY_POLICY',
      metadata,
      message: 'TWO_FACTOR_REQUIRED_BY_POLICY',
    });

    expect(sent.status).toBe(422);
    expect(sent.body.code).toBe('TEMPLATE_INVALID');
  });

  it('maps domain TEMPLATE_INVALID gRPC details to HTTP 422 (FR-DOCS-070)', () => {
    const metadata = {
      get: (key: string) =>
        key === GW_METADATA.ERROR_DETAILS
          ? [Buffer.from(JSON.stringify({ code: 'TEMPLATE_INVALID', reason: 'vba' }))]
          : undefined,
    };
    const sent = run({
      code: GrpcStatus.INVALID_ARGUMENT,
      details: 'unsafe template',
      metadata,
      message: 'unsafe template',
    });

    expect(sent.status).toBe(422);
    expect(sent.body.code).toBe('TEMPLATE_INVALID');
  });
});
