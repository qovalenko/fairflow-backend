import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { Metadata } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { buildGatewayOutboundMetadata } from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

function rpcError(e: unknown): { code?: number; message?: string } {
  return e instanceof RpcException ? (e.getError() as { code?: number; message?: string }) : {};
}

function validMetadata(apiKey = 'ak_test_key'): Metadata {
  return buildGatewayOutboundMetadata({
    serviceApiKey: apiKey,
    gatewayApiKeyId: 'gw-key-1',
    headers: {
      'x-request-id': 'req-1',
      traceparent: '00-abc-def-01',
    },
    actorType: 'service',
  });
}

describe('GatewayApiKeyValidationService', () => {
  let validateServiceApiKey: jest.Mock;
  let service: GatewayApiKeyValidationService;

  beforeEach(() => {
    validateServiceApiKey = jest.fn();
    const authClient = {
      getService: () => ({ validateServiceApiKey }),
    };
    service = new GatewayApiKeyValidationService(authClient as never);
    service.onModuleInit();
  });

  it('rejects calls without x-service-api-key', async () => {
    await expect(service.assertValidGatewayCall(new Metadata())).rejects.toMatchObject({
      message: expect.stringContaining('Missing x-service-api-key'),
    });
    try {
      await service.assertValidGatewayCall(new Metadata());
    } catch (e) {
      expect(rpcError(e).code).toBe(status.UNAUTHENTICATED);
    }
  });

  it('rejects an inactive key returned by auth', async () => {
    validateServiceApiKey.mockReturnValue(of({ active: false }));
    await expect(service.assertValidGatewayCall(validMetadata())).rejects.toBeInstanceOf(
      RpcException,
    );
    try {
      await service.assertValidGatewayCall(validMetadata());
    } catch (e) {
      expect(rpcError(e).code).toBe(status.UNAUTHENTICATED);
      expect(rpcError(e).message).toContain('Invalid gateway service API key');
    }
  });

  it('accepts an active key with propagated gateway metadata', async () => {
    validateServiceApiKey.mockReturnValue(of({ active: true }));
    await expect(service.assertValidGatewayCall(validMetadata())).resolves.toBeUndefined();
    expect(validateServiceApiKey).toHaveBeenCalledWith({ api_key: 'ak_test_key' });
  });

  it('uses the cache for repeated calls with the same key', async () => {
    validateServiceApiKey.mockReturnValue(of({ active: true }));
    const md = validMetadata('ak_cached');
    await service.assertValidGatewayCall(md);
    await service.assertValidGatewayCall(md);
    expect(validateServiceApiKey).toHaveBeenCalledTimes(1);
  });

  it('rejects from cache when auth previously returned inactive', async () => {
    validateServiceApiKey.mockReturnValue(of({ active: false }));
    const md = validMetadata('ak_bad');
    await expect(service.assertValidGatewayCall(md)).rejects.toBeInstanceOf(RpcException);
    validateServiceApiKey.mockClear();
    await expect(service.assertValidGatewayCall(md)).rejects.toBeInstanceOf(RpcException);
    expect(validateServiceApiKey).not.toHaveBeenCalled();
  });

  it('fail-opens on transport error when a recent positive result is within stale grace', async () => {
    validateServiceApiKey.mockReturnValueOnce(of({ active: true }));
    const md = validMetadata('ak_stale_grace');
    await service.assertValidGatewayCall(md);

    validateServiceApiKey.mockReturnValueOnce(throwError(() => new Error('auth down')));
    await expect(service.assertValidGatewayCall(md)).resolves.toBeUndefined();
  });

  it('returns UNAVAILABLE when auth is down and there is no stale positive cache', async () => {
    validateServiceApiKey.mockReturnValue(throwError(() => new Error('connection refused')));
    await expect(service.assertValidGatewayCall(validMetadata('ak_no_cache'))).rejects.toBeInstanceOf(
      RpcException,
    );
    try {
      await service.assertValidGatewayCall(validMetadata('ak_no_cache'));
    } catch (e) {
      expect(rpcError(e).code).toBe(status.UNAVAILABLE);
      expect(rpcError(e).message).toContain('Auth service unavailable');
    }
  });

  it('rejects when propagated metadata is incomplete after key validation', async () => {
    validateServiceApiKey.mockReturnValue(of({ active: true }));
    const md = new Metadata();
    md.set('x-service-api-key', 'ak_test_key');
    await expect(service.assertValidGatewayCall(md)).rejects.toBeInstanceOf(RpcException);
    try {
      await service.assertValidGatewayCall(md);
    } catch (e) {
      expect(rpcError(e).code).toBe(status.UNAUTHENTICATED);
      expect(rpcError(e).message).toContain('x-request-id');
    }
  });
});
