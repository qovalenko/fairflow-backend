import { status } from '@grpc/grpc-js';
import { Observable, of, throwError } from 'rxjs';

/**
 * gRPC client stubs for component tests (QA-CI T-026).
 *
 * A NestJS domain that calls another domain does so through an injected
 * `ClientGrpc` proxy whose methods return an `Observable`. In a component test we
 * replace that proxy with a plain object of stubs; these helpers produce the
 * Observable-returning values so the stub behaves like the real transport (the
 * caller usually pipes it through `firstValueFrom`).
 */

/** An Observable that emits `value` then completes — the success shape of a unary RPC. */
export function grpcOk<T>(value: T): Observable<T> {
  return of(value);
}

/**
 * An Observable that errors with a gRPC-status-shaped error, matching what a real
 * client sees when the callee throws an `RpcException`. Use this to assert that a
 * caller maps/propagates downstream failures correctly.
 */
export function grpcError(
  code: number = status.UNKNOWN,
  message = 'grpc error',
): Observable<never> {
  const err = Object.assign(new Error(message), { code });
  return throwError(() => err);
}

type StubImpl<T> = ((...args: unknown[]) => Observable<T>) | T;

/**
 * Build a mock gRPC service where every listed method returns an Observable.
 * Pass a fixed value (wrapped in `grpcOk`) or a function returning an Observable.
 * Each entry is a `jest.fn`, so callers can assert on invocation args.
 *
 * @example
 *   const userDir = mockGrpcService({ ResolveUsers: { users: [] } });
 *   expect(userDir.ResolveUsers).toHaveBeenCalledWith({ ids: ['u1'] }, anyMeta);
 */
export function mockGrpcService<M extends Record<string, unknown>>(
  methods: { [K in keyof M]: StubImpl<M[K]> },
): { [K in keyof M]: jest.Mock } {
  const out = {} as { [K in keyof M]: jest.Mock };
  for (const key of Object.keys(methods) as (keyof M)[]) {
    const impl = methods[key];
    out[key] = jest.fn((...args: unknown[]) =>
      typeof impl === 'function'
        ? (impl as (...a: unknown[]) => unknown)(...args)
        : grpcOk(impl),
    );
  }
  return out;
}
