import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';
import type { Metadata } from '@grpc/grpc-js';

@Injectable()
export class GrpcInboundApiKeyGuard implements CanActivate {
  constructor(private readonly validator: GatewayApiKeyValidationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'rpc') return true;
    const metadata = context.getArgByIndex(1) as Metadata | undefined;
    await this.validator.assertValidGatewayCall(metadata);
    return true;
  }
}
