import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { RpcAppExceptionFilter } from './rpc-exception.filter';
import { GW_METADATA } from './metadata-keys';

/** Duck-typed domain AppError (errorCode + message [+ details]) — same shape company throws. */
function appError(errorCode: string, message: string, details?: Record<string, unknown>) {
  return { errorCode, message, details, name: 'AppError' };
}

async function caught(exception: unknown): Promise<{ code: number; message: string; metadata?: Metadata }> {
  const filter = new RpcAppExceptionFilter();
  return firstValueFrom(filter.catch(exception, {} as never)) as never;
}

describe('RpcAppExceptionFilter — domain AppError → gRPC', () => {
  it('maps restore-collision (locked) to FAILED_PRECONDITION and carries conflictId+options in metadata', async () => {
    const details = { conflictId: '665f00000000000000000001', options: ['merge', 'clear_key', 'as_new'] };
    // The filter re-throws the RpcException; we exercise the mapping via getError().
    let thrown: unknown;
    try {
      await caught(appError('locked', 'Есть активный дубль по ключу — выберите действие', details));
    } catch (e) {
      thrown = e instanceof RpcException ? e.getError() : e;
    }
    const err = thrown as { code: number; message: string; metadata: Metadata };
    expect(err.code).toBe(GrpcStatus.FAILED_PRECONDITION);
    expect(err.message).toContain('дубль');
    // details ride in trailing metadata under x-error-details-bin (decoded by the gateway).
    const raw = err.metadata.get(GW_METADATA.ERROR_DETAILS)[0] as Buffer;
    expect(raw).toBeDefined();
    expect(JSON.parse(raw.toString('utf8'))).toEqual(details);
  });

  it('maps notFound without details to NOT_FOUND and attaches no metadata', async () => {
    let thrown: unknown;
    try {
      await caught(appError('notFound', 'Company not found'));
    } catch (e) {
      thrown = e instanceof RpcException ? e.getError() : e;
    }
    const err = thrown as { code: number; message: string; metadata?: Metadata };
    expect(err.code).toBe(GrpcStatus.NOT_FOUND);
    expect(err.metadata).toBeUndefined();
  });

  it('packs RpcException.details into x-error-details-bin when metadata is absent', async () => {
    const details = { deals: 2, orders: 1 };
    let thrown: unknown;
    try {
      await caught(
        new RpcException({
          code: GrpcStatus.FAILED_PRECONDITION,
          message: 'blocked',
          details,
        }),
      );
    } catch (e) {
      thrown = e instanceof RpcException ? e.getError() : e;
    }
    const err = thrown as { code: number; message: string; metadata: Metadata };
    expect(err.code).toBe(GrpcStatus.FAILED_PRECONDITION);
    const raw = err.metadata.get(GW_METADATA.ERROR_DETAILS)[0] as Buffer;
    expect(JSON.parse(raw.toString('utf8'))).toEqual(details);
  });
});
