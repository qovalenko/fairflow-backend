import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import type { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

describe('GrpcInboundApiKeyGuard', () => {
  const validator = {
    assertValidGatewayCall: jest.fn().mockResolvedValue(undefined),
  };

  const guard = new GrpcInboundApiKeyGuard(validator as unknown as GatewayApiKeyValidationService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows non-gRPC contexts without validating the API key', async () => {
    const ctx = { getType: () => 'http', getArgByIndex: jest.fn() } as never;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('validates inbound gRPC metadata and returns true on success', async () => {
    const metadata = { get: () => [] };
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: (idx: number) => (idx === 1 ? metadata : undefined),
    } as never;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).toHaveBeenCalledWith(metadata);
  });

  it('propagates validation failures from the validator', async () => {
    validator.assertValidGatewayCall.mockRejectedValueOnce(new Error('invalid key'));
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: () => ({}),
    } as never;

    await expect(guard.canActivate(ctx)).rejects.toThrow('invalid key');
  });
});
