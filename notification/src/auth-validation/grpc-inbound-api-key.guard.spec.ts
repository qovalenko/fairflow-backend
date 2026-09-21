import type { ExecutionContext } from '@nestjs/common';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import type { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

describe('GrpcInboundApiKeyGuard', () => {
  function ctx(type: string, metadata?: unknown): ExecutionContext {
    return {
      getType: () => type,
      getArgByIndex: (i: number) => (i === 1 ? metadata : undefined),
    } as ExecutionContext;
  }

  it('allows non-rpc contexts without calling the validator', async () => {
    const validator = { assertValidGatewayCall: jest.fn() };
    const guard = new GrpcInboundApiKeyGuard(
      validator as unknown as GatewayApiKeyValidationService,
    );
    await expect(guard.canActivate(ctx('http'))).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('validates gateway metadata on rpc calls', async () => {
    const metadata = { get: () => [] };
    const validator = {
      assertValidGatewayCall: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new GrpcInboundApiKeyGuard(
      validator as unknown as GatewayApiKeyValidationService,
    );
    await expect(guard.canActivate(ctx('rpc', metadata))).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).toHaveBeenCalledWith(metadata);
  });

  it('propagates validator rejection on rpc calls', async () => {
    const validator = {
      assertValidGatewayCall: jest.fn().mockRejectedValue(new Error('bad key')),
    };
    const guard = new GrpcInboundApiKeyGuard(
      validator as unknown as GatewayApiKeyValidationService,
    );
    await expect(guard.canActivate(ctx('rpc', {}))).rejects.toThrow('bad key');
  });
});
