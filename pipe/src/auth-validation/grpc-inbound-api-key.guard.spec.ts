import { Metadata } from '@grpc/grpc-js';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';

describe('GrpcInboundApiKeyGuard', () => {
  it('allows non-rpc contexts without validating the gateway key', async () => {
    const validator = { assertValidGatewayCall: jest.fn() };
    const guard = new GrpcInboundApiKeyGuard(validator as never);
    const context = {
      getType: () => 'http',
      getArgByIndex: () => undefined,
    };
    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('validates rpc metadata and returns true on success', async () => {
    const metadata = new Metadata();
    const validator = { assertValidGatewayCall: jest.fn(async () => undefined) };
    const guard = new GrpcInboundApiKeyGuard(validator as never);
    const context = {
      getType: () => 'rpc',
      getArgByIndex: (idx: number) => (idx === 1 ? metadata : undefined),
    };
    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).toHaveBeenCalledWith(metadata);
  });

  it('propagates validation failures from the validator', async () => {
    const validator = {
      assertValidGatewayCall: jest.fn(async () => {
        throw new Error('invalid key');
      }),
    };
    const guard = new GrpcInboundApiKeyGuard(validator as never);
    const context = {
      getType: () => 'rpc',
      getArgByIndex: () => new Metadata(),
    };
    await expect(guard.canActivate(context as never)).rejects.toThrow('invalid key');
  });
});
