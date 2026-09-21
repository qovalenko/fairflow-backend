import { Metadata } from '@grpc/grpc-js';
import { ExecutionContext } from '@nestjs/common';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

describe('GrpcInboundApiKeyGuard', () => {
  const assertValidGatewayCall = jest.fn();
  const validator = { assertValidGatewayCall } as unknown as GatewayApiKeyValidationService;
  const guard = new GrpcInboundApiKeyGuard(validator);

  beforeEach(() => {
    assertValidGatewayCall.mockReset();
    assertValidGatewayCall.mockResolvedValue(undefined);
  });

  it('пропускает non-rpc контекст без валидации', async () => {
    const ctx = { getType: () => 'http', getArgByIndex: jest.fn() } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('валидирует metadata gRPC-вызова', async () => {
    const metadata = new Metadata();
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: jest.fn((i: number) => (i === 1 ? metadata : undefined)),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(assertValidGatewayCall).toHaveBeenCalledWith(metadata);
  });

  it('пробрасывает ошибку валидатора', async () => {
    assertValidGatewayCall.mockRejectedValue(new Error('denied'));
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: jest.fn(() => new Metadata()),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toThrow('denied');
  });
});
