import { Metadata } from '@grpc/grpc-js';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';

describe('GrpcInboundApiKeyGuard', () => {
  it('skips validation for non-rpc contexts', async () => {
    const validator = { assertValidGatewayCall: jest.fn() };
    const guard = new GrpcInboundApiKeyGuard(validator as never);
    const ctx = { getType: () => 'http', getArgByIndex: jest.fn() };
    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('validates propagated metadata on rpc calls', async () => {
    const metadata = new Metadata();
    const validator = { assertValidGatewayCall: jest.fn(async () => undefined) };
    const guard = new GrpcInboundApiKeyGuard(validator as never);
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: (i: number) => (i === 1 ? metadata : undefined),
    };
    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).toHaveBeenCalledWith(metadata);
  });
});
