import { ExecutionContext } from '@nestjs/common';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

describe('GrpcInboundApiKeyGuard', () => {
  const validator = { assertValidGatewayCall: jest.fn() };
  const guard = new GrpcInboundApiKeyGuard(validator as unknown as GatewayApiKeyValidationService);

  beforeEach(() => jest.clearAllMocks());

  it('skips validation for non-gRPC contexts', async () => {
    const ctx = { getType: () => 'http' } as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('validates metadata on gRPC calls', async () => {
    const metadata = { get: () => [] } as never;
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: (idx: number) => (idx === 1 ? metadata : undefined),
    } as ExecutionContext;
    validator.assertValidGatewayCall.mockResolvedValue(undefined);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).toHaveBeenCalledWith(metadata);
  });

  it('propagates validation failures', async () => {
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: () => ({}),
    } as unknown as ExecutionContext;
    validator.assertValidGatewayCall.mockRejectedValue(new Error('denied'));

    await expect(guard.canActivate(ctx)).rejects.toThrow('denied');
  });
});
