import { ExecutionContext } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import type { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

describe('GrpcInboundApiKeyGuard', () => {
  let validator: { assertValidGatewayCall: jest.Mock };
  let guard: GrpcInboundApiKeyGuard;

  beforeEach(() => {
    validator = { assertValidGatewayCall: jest.fn().mockResolvedValue(undefined) };
    guard = new GrpcInboundApiKeyGuard(validator as unknown as GatewayApiKeyValidationService);
  });

  function rpcContext(metadata: Metadata | undefined): ExecutionContext {
    return {
      getType: () => 'rpc',
      getArgByIndex: (idx: number) => (idx === 1 ? metadata : undefined),
    } as ExecutionContext;
  }

  it('skips validation for non-rpc contexts', async () => {
    const ctx = { getType: () => 'http' } as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('validates gateway metadata on rpc calls', async () => {
    const md = new Metadata();
    md.set('x-service-api-key', 'ak_test');
    await expect(guard.canActivate(rpcContext(md))).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).toHaveBeenCalledWith(md);
  });

  it('propagates validation failures', async () => {
    validator.assertValidGatewayCall.mockRejectedValue(new Error('invalid key'));
    await expect(guard.canActivate(rpcContext(new Metadata()))).rejects.toThrow('invalid key');
  });
});
