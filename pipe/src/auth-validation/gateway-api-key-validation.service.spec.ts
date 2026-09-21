import { createHash } from 'node:crypto';
import { Metadata, status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { GW_METADATA } from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

function validMetadata(apiKey = 'ak_valid_key'): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.SERVICE_API_KEY, apiKey);
  m.set(GW_METADATA.REQUEST_ID, 'req-1');
  m.set(GW_METADATA.TRACE_ID, 'trace-1');
  m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  m.set(GW_METADATA.ACTOR_TYPE, 'service');
  return m;
}

function makeService(validate: jest.Mock) {
  const authClient = {
    getService: () => ({ validateServiceApiKey: validate }),
  };
  const svc = new GatewayApiKeyValidationService(authClient as never);
  svc.onModuleInit();
  return svc;
}

describe('GatewayApiKeyValidationService', () => {
  it('rejects calls without x-service-api-key', async () => {
    const svc = makeService(jest.fn());
    await expect(svc.assertValidGatewayCall(new Metadata())).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.UNAUTHENTICATED }),
    });
  });

  it('rejects an inactive key returned by auth', async () => {
    const validate = jest.fn(() => of({ active: false }));
    const svc = makeService(validate);
    await expect(svc.assertValidGatewayCall(validMetadata())).rejects.toMatchObject({
      error: expect.objectContaining({
        code: status.UNAUTHENTICATED,
        message: 'Invalid gateway service API key',
      }),
    });
    expect(validate).toHaveBeenCalledWith({ api_key: 'ak_valid_key' });
  });

  it('accepts an active key when propagated metadata is complete', async () => {
    const validate = jest.fn(() => of({ active: true }));
    const svc = makeService(validate);
    await expect(svc.assertValidGatewayCall(validMetadata())).resolves.toBeUndefined();
  });

  it('serves a fresh positive cache hit without re-calling auth', async () => {
    const validate = jest.fn(() => of({ active: true }));
    const svc = makeService(validate);
    const md = validMetadata('ak_cached');
    await svc.assertValidGatewayCall(md);
    await svc.assertValidGatewayCall(md);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh negative cache hit without re-calling auth', async () => {
    const validate = jest.fn(() => of({ active: false }));
    const svc = makeService(validate);
    const md = validMetadata('ak_bad');
    await expect(svc.assertValidGatewayCall(md)).rejects.toBeInstanceOf(RpcException);
    await expect(svc.assertValidGatewayCall(md)).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.UNAUTHENTICATED }),
    });
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('fail-opens on transport errors when a positive entry is within stale grace', async () => {
    const validate = jest
      .fn()
      .mockImplementationOnce(() => of({ active: true }))
      .mockImplementation(() => throwError(() => new Error('auth down')));
    const svc = makeService(validate);
    const md = validMetadata('ak_stale_ok');
    await svc.assertValidGatewayCall(md);

    const h = createHash('sha256').update('ak_stale_ok').digest('hex');
    const entry = (svc as unknown as { cache: Map<string, { exp: number }> }).cache.get(h)!;
    entry.exp = Date.now() - 1;
    await expect(svc.assertValidGatewayCall(md)).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('surfaces UNAVAILABLE when auth is down and there is no stale positive entry', async () => {
    const validate = jest.fn(() => throwError(() => new Error('auth down')));
    const svc = makeService(validate);
    await expect(svc.assertValidGatewayCall(validMetadata('ak_unreachable'))).rejects.toMatchObject(
      {
        error: expect.objectContaining({
          code: status.UNAVAILABLE,
          message: expect.stringContaining('Auth service unavailable'),
        }),
      },
    );
  });

  it('rejects valid keys when propagated gateway metadata is incomplete', async () => {
    const validate = jest.fn(() => of({ active: true }));
    const svc = makeService(validate);
    const md = new Metadata();
    md.set(GW_METADATA.SERVICE_API_KEY, 'ak_valid_key');
    await expect(svc.assertValidGatewayCall(md)).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.UNAUTHENTICATED }),
    });
  });
});
