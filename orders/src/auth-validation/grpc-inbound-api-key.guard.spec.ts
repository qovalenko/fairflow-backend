import { Metadata } from '@grpc/grpc-js';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';

describe('GrpcInboundApiKeyGuard', () => {
  it('allows non-gRPC contexts without calling the validator', async () => {
    const validator = { assertValidGatewayCall: jest.fn() };
    const guard = new GrpcInboundApiKeyGuard(validator as never);
    const ctx = {
      getType: () => 'http',
      getArgByIndex: jest.fn(),
    };
    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('delegates gRPC metadata to the validator', async () => {
    const meta = new Metadata();
    const validator = { assertValidGatewayCall: jest.fn().mockResolvedValue(undefined) };
    const guard = new GrpcInboundApiKeyGuard(validator as never);
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: (i: number) => (i === 1 ? meta : undefined),
    };
    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).toHaveBeenCalledWith(meta);
  });

  it('propagates validator failures', async () => {
    const validator = {
      assertValidGatewayCall: jest.fn().mockRejectedValue(new Error('denied')),
    };
    const guard = new GrpcInboundApiKeyGuard(validator as never);
    const ctx = { getType: () => 'rpc', getArgByIndex: () => new Metadata() };
    await expect(guard.canActivate(ctx as never)).rejects.toThrow('denied');
  });
});
