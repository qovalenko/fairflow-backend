import { SetMetadata } from '@nestjs/common';

export const SKIP_GATEWAY_KEY = 'skipGatewayKey';
export const SkipGatewayKey = () => SetMetadata(SKIP_GATEWAY_KEY, true);
