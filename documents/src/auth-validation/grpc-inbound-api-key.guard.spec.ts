import { Metadata } from '@grpc/grpc-js';
import { ExecutionContext } from '@nestjs/common';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

describe('GrpcInboundApiKeyGuard', () => {
  const assertValidGatewayCall = jest.fn().mockResolvedValue(undefined);
  const validator = { assertValidGatewayCall } as unknown as GatewayApiKeyValidationService;
  const guard = new GrpcInboundApiKeyGuard(validator);

  beforeEach(() => {
    assertValidGatewayCall.mockClear();
  });

  it('skips validation for non-gRPC contexts', async () => {
    const ctx = {
      getType: () => 'http',
      getArgByIndex: jest.fn(),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('validates inbound gRPC metadata before allowing the handler', async () => {
    const metadata = new Metadata();
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: (idx: number) => (idx === 1 ? metadata : undefined),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(assertValidGatewayCall).toHaveBeenCalledWith(metadata);
  });

  it('propagates validation failures from the PEP', async () => {
    assertValidGatewayCall.mockRejectedValueOnce(new Error('denied'));
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: () => new Metadata(),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toThrow('denied');
  });
});
