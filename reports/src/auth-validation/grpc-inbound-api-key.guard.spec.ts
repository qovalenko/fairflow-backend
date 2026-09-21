import { ExecutionContext } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import type { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

describe('GrpcInboundApiKeyGuard', () => {
  const validator = {
    assertValidGatewayCall: jest.fn().mockResolvedValue(undefined),
  } as unknown as GatewayApiKeyValidationService;
  const guard = new GrpcInboundApiKeyGuard(validator);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('пропускает non-rpc контекст без валидации', async () => {
    const ctx = { getType: () => 'http' } as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).not.toHaveBeenCalled();
  });

  it('валидирует gRPC metadata (arg index 1)', async () => {
    const md = new Metadata();
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: (i: number) => (i === 1 ? md : undefined),
    } as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validator.assertValidGatewayCall).toHaveBeenCalledWith(md);
  });

  it('пробрасывает ошибку валидатора', async () => {
    (validator.assertValidGatewayCall as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    const ctx = {
      getType: () => 'rpc',
      getArgByIndex: () => new Metadata(),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow('denied');
  });
});
