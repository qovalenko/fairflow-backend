import { Metadata } from '@grpc/grpc-js';
import { ExecutionContext } from '@nestjs/common';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

describe('GrpcInboundApiKeyGuard', () => {
  it('skips validation for non-rpc contexts', async () => {
    const validator = { assertValidGatewayCall: jest.fn() };
    const guard = new GrpcInboundApiKeyGuard(
      validator as unknown as GatewayApiKeyValidationService,
    );
    const ctx = {
      getType: () => 'http',
      getArgByIndex: jest.fn(),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('validates gateway metadata on rpc calls', async () => {
    const validator = { assertValidGatewayCall: jest.fn().mockResolvedValue(undefined) };
    const guard = new GrpcInboundApiKeyGuard(
      validator as unknown as GatewayApiKeyValidationService,
    );
    const md = new Metadata();
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: jest.fn().mockReturnValue(md),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).toHaveBeenCalledWith(md);
  });
});
