import * as crypto from 'node:crypto';

const AK_PREFIX = 'ak_';

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function prefixApiKey(key: string): string {
  return key.slice(0, AK_PREFIX.length + 8);
}

/** Deterministic automation service key derived from the gateway master key (TODO-021). */
export function deriveAutomationServiceKey(gatewayKey: string): string {
  const body = crypto
    .createHmac('sha256', gatewayKey)
    .update('fairflow:automation-service-key:v1')
    .digest('base64url');
  return `${AK_PREFIX}${body.slice(0, 40)}`;
}
