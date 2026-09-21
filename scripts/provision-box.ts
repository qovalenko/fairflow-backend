/**
 * Box (on-prem, single-tenant) deterministic provisioner — 03-ARCHITECTURE.md §4.3.
 *
 * Runs the INFRA half only: upsert the service API keys (gateway master +
 * directory keys) + the `fairflow-app` OAuth2 client, reading the SAME plaintext
 * keys the pods send. Migrations are done by the surrounding npm script
 * (`db:provision:box`). This script:
 *   - does NOT create users / organizations / projects (bootstrap does that via
 *     the UI at first launch, §5),
 *   - does NOT touch control / mongo,
 *   - does NOT write `.fairflow-dev.env`,
 *   - does NOT migrate billing.
 * Idempotent (upsert by keyHash / clientId) — safe as a helm PreSync hook on
 * every deploy. Fixes the box login grpcCode=16 by construction (§2.1).
 *
 * Requires: DATABASE_URL, GATEWAY_SERVICE_API_KEY.
 * Optional:  GATEWAY_API_KEY_ID, NOTIFICATION_SERVICE_API_KEY,
 *            CONTROL_SERVICE_API_KEY, AUTOMATION_SERVICE_API_KEY,
 *            OAUTH_APP_CLIENT_SECRET.
 */
import * as path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient as AuthPrisma } from '../auth/src/generated/prisma';
import { provisionServiceApiKeys } from './provision-keys';

const servicesRoot = path.resolve(__dirname, '..');

export async function provisionBox(): Promise<void> {
  // In k8s the env comes from the pod; a local `.env` is a convenience.
  loadEnv({ path: path.join(servicesRoot, '.env') });

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  const gatewayKey = process.env.GATEWAY_SERVICE_API_KEY?.trim();
  if (!gatewayKey) {
    console.error('GATEWAY_SERVICE_API_KEY is required (gateway master service key, ak_...).');
    process.exit(1);
  }

  const adapter = new PrismaPg({ connectionString });
  const auth = new AuthPrisma({ adapter });

  try {
    const result = await provisionServiceApiKeys(auth, {
      gatewayKey,
      gatewayKeyId: process.env.GATEWAY_API_KEY_ID?.trim() || undefined,
      notificationKey: process.env.NOTIFICATION_SERVICE_API_KEY?.trim() || undefined,
      controlKey: process.env.CONTROL_SERVICE_API_KEY?.trim() || undefined,
      automationKey: process.env.AUTOMATION_SERVICE_API_KEY?.trim() || undefined,
      oauthAppClientSecret: process.env.OAUTH_APP_CLIENT_SECRET?.trim() || undefined,
    });
    console.log('');
    console.log('Box service keys provisioned. For the gateway secret:');
    console.log('  GATEWAY_SERVICE_API_KEY=<the same key you passed here>');
    console.log('  GATEWAY_API_KEY_ID=' + result.gatewayKeyId);
    if (result.automationKeyId) {
      console.log('  AUTOMATION_API_KEY_ID=' + result.automationKeyId + ' (for the automation deployment env)');
    }
    if (result.automationPlainKey) {
      console.log('  AUTOMATION_SERVICE_API_KEY=' + result.automationPlainKey);
    }
    if (!process.env.GATEWAY_API_KEY_ID?.trim()) {
      console.log('  (GATEWAY_API_KEY_ID was auto-generated — set it in the secret to avoid');
      console.log('   a fresh id on the next provision; recommended to pin it up front.)');
    }
  } finally {
    await auth.$disconnect();
  }
}

if (require.main === module) {
  provisionBox().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
