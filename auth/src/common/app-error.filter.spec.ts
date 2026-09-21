import { HttpException, HttpStatus } from '@nestjs/common';
import { AppErrorFilter } from './app-error.filter';
import { AppError } from './errors';

type Sent = { status?: number; body?: Record<string, unknown> };

function runHttp(exception: unknown): Sent {
  const sent: Sent = {};
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
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => reply }),
  };
  new AppErrorFilter().catch(exception, host as never);
  return sent;
}

describe('AppErrorFilter HTTP transport', () => {
  it('maps AppError auth code to 401 with errorCode envelope', () => {
    const sent = runHttp(new AppError('auth', 'bad credentials'));
    expect(sent.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(sent.body).toMatchObject({
      statusCode: 401,
      errorCode: 'auth',
      message: 'bad credentials',
    });
  });

  it('renders OAuth invalid_grant in RFC 6749 shape', () => {
    const sent = runHttp(new AppError('invalid_grant', 'code expired'));
    expect(sent.status).toBe(HttpStatus.BAD_REQUEST);
    expect(sent.body).toEqual({ error: 'invalid_grant', error_description: 'code expired' });
  });

  it('passes through HttpException status and body', () => {
    const sent = runHttp(new HttpException({ message: 'nope' }, HttpStatus.NOT_FOUND));
    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({ message: 'nope' });
  });

  it('returns generic 500 for unknown errors', () => {
    const sent = runHttp(new Error('boom'));
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({ message: 'Internal error' });
  });
});

describe('AppErrorFilter gRPC transport', () => {
  it('delegates non-http contexts to RpcAppExceptionFilter', () => {
    const filter = new AppErrorFilter();
    const rpc = (filter as unknown as { rpc: { catch: jest.Mock } }).rpc;
    const rpcSpy = jest.spyOn(rpc, 'catch').mockReturnValue(undefined as never);
    const host = { getType: () => 'rpc' };
    const err = new AppError('access', 'denied');
    filter.catch(err, host as never);
    expect(rpcSpy).toHaveBeenCalledWith(err, host);
    rpcSpy.mockRestore();
  });
});
