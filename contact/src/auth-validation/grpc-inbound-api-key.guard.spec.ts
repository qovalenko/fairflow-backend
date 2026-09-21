import { ExecutionContext } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

function rpcContext(metadata?: Metadata): ExecutionContext {
  return {
    getType: () => 'rpc',
    getArgByIndex: (i: number) => (i === 1 ? metadata : {}),
  } as unknown as ExecutionContext;
}

function httpContext(): ExecutionContext {
  return { getType: () => 'http' } as unknown as ExecutionContext;
}

describe('GrpcInboundApiKeyGuard', () => {
  it('delegates rpc calls to GatewayApiKeyValidationService', async () => {
    const metadata = new Metadata();
    const validator = {
      assertValidGatewayCall: jest.fn().mockResolvedValue(undefined),
    } as unknown as GatewayApiKeyValidationService;
    const guard = new GrpcInboundApiKeyGuard(validator);

    await expect(guard.canActivate(rpcContext(metadata))).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).toHaveBeenCalledWith(metadata);
  });

  it('propagates validation failures from the service', async () => {
    const validator = {
      assertValidGatewayCall: jest.fn().mockRejectedValue(new Error('bad key')),
    } as unknown as GatewayApiKeyValidationService;
    const guard = new GrpcInboundApiKeyGuard(validator);

    await expect(guard.canActivate(rpcContext(new Metadata()))).rejects.toThrow('bad key');
  });

  it('allows non-rpc contexts without calling the validator', async () => {
    const validator = {
      assertValidGatewayCall: jest.fn(),
    } as unknown as GatewayApiKeyValidationService;
    const guard = new GrpcInboundApiKeyGuard(validator);

    await expect(guard.canActivate(httpContext())).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).not.toHaveBeenCalled();
  });
});
