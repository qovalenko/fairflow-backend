/**
 * Deterministic, idempotent provisioning of the SERVICE API keys + the
 * `fairflow-app` OAuth2 client, extracted from `postgres-seed.ts` so both the
 * SaaS seed and the box provisioner (`provision-box.ts`) share one source of
 * truth (03-ARCHITECTURE.md §2.3, §4.3). Contains NO demo/business data.
 *
 * The plaintext keys are the SAME strings the gateway/notification/control send
 * in gRPC metadata; here we hash (sha256) and upsert by `keyHash`, so the key
 * that is SENT and the key that is STORED can never drift (fixes grpcCode=16,
 * §2.1). Upsert-by-keyHash / clientId makes it safe to run on every deploy, and
 * a CHANGED value converges: the superseded row of the same slot is deactivated
 * (rotating a secret in the chart must actually revoke the old one, §4.3).
 */
import * as bcrypt from 'bcryptjs';
import { newEntityId } from '@fairflow/shared';
import type { PrismaClient as AuthPrisma } from '../auth/src/generated/prisma';
import {
  deriveAutomationServiceKey,
  hashApiKey,
  prefixApiKey,
} from './provision-key-crypto';

export { deriveAutomationServiceKey, hashApiKey, prefixApiKey };

const AK_PREFIX = 'ak_';

/**
 * Deterministic `name` of every ApiKey row this provisioner owns. It is the slot
 * identity: on rotation the new value lands in a NEW row (keyHash is the upsert
 * key), so the superseded row of the SAME slot has to be deactivated by name —
 * hand-made keys and the other slots stay untouched.
 */
const GATEWAY_KEY_NAME = 'Gateway service key';
const NOTIFICATION_KEY_NAME = 'Notification directory key';
const CONTROL_KEY_NAME = 'Control directory key';
const AUTOMATION_KEY_NAME = 'Automation service key';

export interface ProvisionKeysOptions {
  /** Gateway master key (`ak_...`), scope `gateway:invoke`. Required. */
  gatewayKey: string;
  /**
   * Deterministic `ApiKey.id` for the gateway key. When set, the gateway can
   * reference the exact row via `x-gateway-api-key-id` with zero manual steps.
   * When omitted a UUIDv7 is minted.
   */
  gatewayKeyId?: string;
  /** notification directory key (`ak_...`), scope `internal:user-directory`. */
  notificationKey?: string;
  /** control directory key (`ak_...`), scope `internal:user-directory`. */
  controlKey?: string;
  /**
   * automation service key (`ak_...`), scope `gateway:invoke` — the automation
   * domain's OWN s2s identity for executor calls (activity) and control
   * module-state lookups. Domain inbound guards validate any active key with
   * this scope via `ApiKeyGrpc.ValidateServiceApiKey`.
   */
  automationKey?: string;
  /**
   * clientSecret for the `fairflow-app` OAuth2 client (plaintext, bcrypt-hashed
   * here). Applied on every run — setting it later rotates the stored hash. When
   * omitted the existing secret is kept (a random one on the first install).
   */
  oauthAppClientSecret?: string;
}

export interface ProvisionKeysResult {
  gatewayKeyId: string;
  oauthClientId: string;
  notificationKeyId?: string;
  controlKeyId?: string;
  automationKeyId?: string;
  /** Plaintext automation key actually provisioned (explicit or derived). */
  automationPlainKey?: string;
}

/**
 * Upsert the gateway service key + optional directory keys + the `fairflow-app`
 * OAuth2 client. Idempotent (upsert by `keyHash` / `clientId`) and convergent
 * (a superseded key of the same slot is deactivated). Directory keys
 * intentionally leave `clientId` null — it is a FK to OAuth2Client (P2003 if set
 * to a free-form string); attribution lives in `name`.
 */
export async function provisionServiceApiKeys(
  auth: AuthPrisma,
  opts: ProvisionKeysOptions,
): Promise<ProvisionKeysResult> {
  const gatewayPlainKey = opts.gatewayKey?.trim();
  if (!gatewayPlainKey) {
    throw new Error('provisionServiceApiKeys: gatewayKey is required');
  }

  /**
   * A rotation is only a rotation if the previous value stops working: an
   * upsert by `keyHash` inserts a new row and leaves the superseded one
   * `isActive` forever (box has no revoke path — ApiKeysService.revoke is not
   * reachable over HTTP).
   */
  const deactivateSuperseded = async (name: string, scope: string, currentHash: string) => {
    const { count } = await auth.apiKey.updateMany({
      where: {
        name,
        scopes: { has: scope },
        isActive: true,
        keyHash: { not: currentHash },
      },
      data: { isActive: false },
    });
    if (count > 0) {
      console.log('Deactivated superseded keys:', name, '- count:', count);
    }
  };

  // ─── OAuth2 client `fairflow-app` (login-flow, needed in box too, §2.3) ───
  // No ENV secret on the FIRST install → mint a random one instead of a
  // published constant (03-ARCHITECTURE.md R9); a later OAUTH_APP_CLIENT_SECRET
  // converges the row, an absent one leaves whatever is already there.
  const oauthPlainSecret = opts.oauthAppClientSecret?.trim();
  const clientSecret = await bcrypt.hash(
    oauthPlainSecret || crypto.randomBytes(32).toString('base64url'),
    10,
  );
  const client = await auth.oAuth2Client.upsert({
    where: { clientId: 'fairflow-app' },
    update: oauthPlainSecret ? { clientSecret, isActive: true } : {},
    create: {
      id: newEntityId(),
      clientId: 'fairflow-app',
      clientSecret,
      name: 'Fairflow App',
      redirectUris: ['http://localhost:3000/callback', 'http://localhost:5173/callback'],
      grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
      scopes: ['openid', 'profile', 'email'],
      isPublic: false,
      isActive: true,
    },
  });
  console.log('OAuth2 client:', client.clientId, 'internal id:', client.id);

  // ─── Gateway master key: scope gateway:invoke, deterministic id if provided ───
  const gwHash = hashApiKey(gatewayPlainKey);
  const gatewayKey = await auth.apiKey.upsert({
    where: { keyHash: gwHash },
    update: {
      isActive: true,
      scopes: ['gateway:invoke'],
      name: GATEWAY_KEY_NAME,
    },
    create: {
      id: opts.gatewayKeyId?.trim() || newEntityId(),
      keyHash: gwHash,
      keyPrefix: prefixApiKey(gatewayPlainKey),
      name: GATEWAY_KEY_NAME,
      scopes: ['gateway:invoke'],
    },
  });
  console.log('Gateway service key:', gatewayKey.id, '(scope gateway:invoke)');
  await deactivateSuperseded(GATEWAY_KEY_NAME, 'gateway:invoke', gwHash);

  // ─── Scoped s2s directory keys (P-resolveusers-servicekey): notification &
  // control call auth `UserDirectoryGrpc.ResolveUsers` (PII) with a key scoped to
  // `internal:user-directory` — NOT the gateway master key. clientId stays null
  // (FK to OAuth2Client — P2003 if set to a free-form string). ───
  const upsertDirectoryKey = async (plainKey: string, name: string) => {
    const keyHash = hashApiKey(plainKey);
    const key = await auth.apiKey.upsert({
      where: { keyHash },
      update: {
        isActive: true,
        scopes: ['internal:user-directory'],
        name,
      },
      create: {
        id: newEntityId(),
        keyHash,
        keyPrefix: prefixApiKey(plainKey),
        name,
        scopes: ['internal:user-directory'],
      },
    });
    await deactivateSuperseded(name, 'internal:user-directory', keyHash);
    return key;
  };

  let notificationKeyId: string | undefined;
  const notificationPlainKey = opts.notificationKey?.trim();
  if (notificationPlainKey) {
    const k = await upsertDirectoryKey(notificationPlainKey, NOTIFICATION_KEY_NAME);
    notificationKeyId = k.id;
    console.log('Notification directory key:', k.id, '(scope internal:user-directory)');
  } else {
    console.warn('notificationKey not set — skipping notification directory key.');
  }

  let controlKeyId: string | undefined;
  const controlPlainKey = opts.controlKey?.trim();
  if (controlPlainKey) {
    const k = await upsertDirectoryKey(controlPlainKey, CONTROL_KEY_NAME);
    controlKeyId = k.id;
    console.log('Control directory key:', k.id, '(scope internal:user-directory)');
  } else {
    console.warn('controlKey not set — skipping control directory key.');
  }

  // ─── Automation service key (TODO-021): automation's own s2s identity for the
  // action executors (activity) and control module-state lookups. Scope
  // `gateway:invoke` — the only scope `ValidateServiceApiKey` accepts, i.e. the
  // scope every domain inbound guard checks. ───
  let automationKeyId: string | undefined;
  const automationPlainKey =
    opts.automationKey?.trim() || deriveAutomationServiceKey(gatewayPlainKey);
  if (!opts.automationKey?.trim()) {
    console.log(
      'AUTOMATION_SERVICE_API_KEY not set — using deterministic derivation from gateway key.',
    );
  }
  if (automationPlainKey) {
    const amHash = hashApiKey(automationPlainKey);
    const k = await auth.apiKey.upsert({
      where: { keyHash: amHash },
      update: {
        isActive: true,
        scopes: ['gateway:invoke'],
        name: AUTOMATION_KEY_NAME,
      },
      create: {
        id: newEntityId(),
        keyHash: amHash,
        keyPrefix: prefixApiKey(automationPlainKey),
        name: AUTOMATION_KEY_NAME,
        scopes: ['gateway:invoke'],
      },
    });
    await deactivateSuperseded(AUTOMATION_KEY_NAME, 'gateway:invoke', amHash);
    automationKeyId = k.id;
    console.log('Automation service key:', k.id, '(scope gateway:invoke)');
  }

  return {
    gatewayKeyId: gatewayKey.id,
    oauthClientId: client.id,
    notificationKeyId,
    controlKeyId,
    automationKeyId,
    automationPlainKey,
  };
}
