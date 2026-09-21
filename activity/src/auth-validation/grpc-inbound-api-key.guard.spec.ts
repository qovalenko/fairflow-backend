import { ExecutionContext } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';

describe('GrpcInboundApiKeyGuard', () => {
  it('allows non-rpc contexts without calling the validator', async () => {
    const validator = { assertValidGatewayCall: jest.fn() };
    const guard = new GrpcInboundApiKeyGuard(validator as never);
    const ctx = { getType: () => 'http' } as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('validates inbound rpc metadata via the PEP service', async () => {
    const metadata = new Metadata();
    const validator = { assertValidGatewayCall: jest.fn().mockResolvedValue(undefined) };
    const guard = new GrpcInboundApiKeyGuard(validator as never);
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: (index: number) => (index === 1 ? metadata : undefined),
    } as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).toHaveBeenCalledWith(metadata);
  });

  it('propagates validator failures', async () => {
    const validator = {
      assertValidGatewayCall: jest.fn().mockRejectedValue(new Error('denied')),
    };
    const guard = new GrpcInboundApiKeyGuard(validator as never);
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: () => new Metadata(),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow('denied');
  });
});
