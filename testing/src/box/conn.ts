/**
 * the box stand connection kit defaults — override via env in CI/local harness.
 */
import * as crypto from 'node:crypto';

export const BOX_HOST = process.env.BOX_FF_HOST ?? 'localhost';

export const BOX_GATEWAY_API_BASE =
  process.env.BOX_GATEWAY_API_BASE ?? `http://${BOX_HOST}:3000/api`;

/** Local gateway HTTP base for integration specs (`/api` suffix). */
export const LOCAL_GATEWAY_API_BASE =
  process.env.LOCAL_GATEWAY_API_BASE ?? 'http://127.0.0.1:13000/api';

export const BOX_POSTGRES_URI =
  process.env.BOX_POSTGRES_URL ??
  process.env.DATABASE_URL ??
  `postgresql://fairflow:CHANGE_ME@${BOX_HOST}:5432/fairflow`;

/** Alias used by money/offboard harness code. */
export const BOX_POSTGRES_URL = BOX_POSTGRES_URI;

export const BOX_MONGODB_URI =
  process.env.BOX_MONGODB_URI ??
  `mongodb://root:CHANGE_ME@${BOX_HOST}:27017/fairflow?authSource=admin`;

export const BOX_RABBITMQ_URL =
  process.env.BOX_RABBITMQ_URL ??
  `amqp://fairflow:CHANGE_ME@${BOX_HOST}:5672/`;

export const BOX_REDIS_URL =
  process.env.REDIS_URL ?? `redis://:CHANGE_ME@${BOX_HOST}:16379`;

export const BOX_GATEWAY_SERVICE_API_KEY =
  process.env.GATEWAY_SERVICE_API_KEY ?? 'ak_CHANGE_ME';

export const BOX_JWT_SECRET =
  process.env.JWT_SECRET ?? 'CHANGE_ME';

export const BOX_PEER_GRPC = {
  auth: process.env.AUTH_GRPC_URL ?? `${BOX_HOST}:5001`,
  control: process.env.CONTROL_GRPC_URL ?? `${BOX_HOST}:5002`,
  contact: process.env.CONTACT_GRPC_URL ?? `${BOX_HOST}:5003`,
  company: process.env.COMPANY_GRPC_URL ?? `${BOX_HOST}:5004`,
  pipe: process.env.PIPE_GRPC_URL ?? `${BOX_HOST}:5005`,
  orders: process.env.ORDERS_GRPC_URL ?? `${BOX_HOST}:5006`,
  product: process.env.PRODUCT_GRPC_URL ?? `${BOX_HOST}:5007`,
  activity: process.env.ACTIVITY_GRPC_URL ?? `${BOX_HOST}:5008`,
  documents: process.env.DOCUMENTS_GRPC_URL ?? `${BOX_HOST}:5010`,
  search: process.env.SEARCH_GRPC_URL ?? `${BOX_HOST}:5013`,
  automation: process.env.AUTOMATION_GRPC_URL ?? `${BOX_HOST}:5012`,
  notification: process.env.NOTIFICATION_GRPC_URL ?? `${BOX_HOST}:5015`,
  chat: process.env.CHAT_GRPC_URL ?? `${BOX_HOST}:5016`,
  audit: process.env.AUDIT_GRPC_URL ?? `${BOX_HOST}:5014`,
} as const;

/** Local orders gRPC (money / orders integration closure wave). */
export const LOCAL_ORDERS_GRPC_URL =
  process.env.LOCAL_ORDERS_GRPC_URL ?? process.env.ORDERS_GRPC_URL ?? '127.0.0.1:5006';

/** Local control gRPC (offboard / purge integration closure wave). */
export const LOCAL_CONTROL_GRPC_URL =
  process.env.LOCAL_CONTROL_GRPC_URL ?? process.env.CONTROL_GRPC_URL ?? '127.0.0.1:5002';

/** Local contact gRPC (merge-group integration closure wave). */
export const LOCAL_CONTACT_GRPC_URL =
  process.env.LOCAL_CONTACT_GRPC_URL ?? process.env.CONTACT_GRPC_URL ?? '127.0.0.1:5003';

/** Local automation gRPC (docs + money integration closure waves). */
export const LOCAL_AUTOMATION_GRPC_URL =
  process.env.LOCAL_AUTOMATION_GRPC_URL ?? '127.0.0.1:15012';

/** Local product gRPC (#9: the box stand product blocks force-delete when deals link). */
export const LOCAL_PRODUCT_GRPC_URL =
  process.env.LOCAL_PRODUCT_GRPC_URL ?? '127.0.0.1:15007';

/** Local documents gRPC (docs wave). */
export const LOCAL_DOCUMENTS_GRPC_URL =
  process.env.LOCAL_DOCUMENTS_GRPC_URL ?? '127.0.0.1:15010';

export const BOX_INTEGRATION_PREFIX = process.env.BOX_INTEGRATION_PREFIX ?? 'intclosure-';

export function uniqueBoxName(label: string): string {
  return `${BOX_INTEGRATION_PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

/** Alias for orchestrator grep compatibility. */
export const boxUniqueName = uniqueBoxName;

export function hasBoxIntegrationEnv(): boolean {
  return process.env.BOX_INTEGRATION === '1';
}

export function deriveBoxAutomationServiceKey(): string {
  const body = crypto
    .createHmac('sha256', BOX_GATEWAY_SERVICE_API_KEY)
    .update('fairflow:automation-service-key:v1')
    .digest('base64url');
  return `ak_${body.slice(0, 40)}`;
}

/** Env block for spawning the local orders service against the box stand peers + stores. */
export function localOrdersServiceEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    PORT: '3010',
    GRPC_ORDERS_PORT: '5006',
    HOST: '0.0.0.0',
    MONGODB_URI: BOX_MONGODB_URI,
    RABBITMQ_URL: BOX_RABBITMQ_URL,
    AUTH_GRPC_URL: BOX_PEER_GRPC.auth,
    CONTROL_GRPC_URL: BOX_PEER_GRPC.control,
    CONTACT_GRPC_URL: BOX_PEER_GRPC.contact,
    COMPANY_GRPC_URL: BOX_PEER_GRPC.company,
    PIPE_GRPC_URL: BOX_PEER_GRPC.pipe,
    PRODUCT_GRPC_URL: BOX_PEER_GRPC.product,
    GATEWAY_SERVICE_API_KEY: BOX_GATEWAY_SERVICE_API_KEY,
    ORDERS_SERVICE_API_KEY: BOX_GATEWAY_SERVICE_API_KEY,
    JWT_SECRET: BOX_JWT_SECRET,
    GRPC_REFLECTION_ENABLED: 'false',
    PROJECT_PURGE_CONSUMERS_ENABLED: 'false',
    DEAL_WON_CONSUMER_ENABLED: 'true',
    CONTACT_MERGED_CONSUMER_ENABLED: 'true',
    COMPANY_MERGED_CONSUMER_ENABLED: 'true',
    ...overrides,
  };
}

/** Env block for spawning the local contact service against the box stand peers + stores. */
export function localContactServiceEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    PORT: '3003',
    GRPC_PORT: '5003',
    HOST: '0.0.0.0',
    MONGODB_URI: BOX_MONGODB_URI,
    RABBITMQ_URL: BOX_RABBITMQ_URL,
    AUTH_GRPC_URL: BOX_PEER_GRPC.auth,
    CONTROL_GRPC_URL: BOX_PEER_GRPC.control,
    COMPANY_GRPC_URL: BOX_PEER_GRPC.company,
    GATEWAY_SERVICE_API_KEY: BOX_GATEWAY_SERVICE_API_KEY,
    JWT_SECRET: BOX_JWT_SECRET,
    GRPC_REFLECTION_ENABLED: 'false',
    COMPANY_DELETED_CONSUMERS_ENABLED: 'true',
    PROJECT_PURGE_CONSUMERS_ENABLED: 'false',
    ...overrides,
  };
}

/** Env block for spawning local automation against the box stand peers + stores. */
export function localAutomationServiceEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    HTTP_PORT: '13012',
    GRPC_AUTOMATION_PORT: '15012',
    HOST: '0.0.0.0',
    MONGODB_URI: BOX_MONGODB_URI,
    RABBITMQ_URL: BOX_RABBITMQ_URL,
    AUTH_GRPC_URL: BOX_PEER_GRPC.auth,
    CONTROL_GRPC_URL: BOX_PEER_GRPC.control,
    PIPE_GRPC_URL: BOX_PEER_GRPC.pipe,
    CONTACT_GRPC_URL: BOX_PEER_GRPC.contact,
    COMPANY_GRPC_URL: BOX_PEER_GRPC.company,
    PRODUCT_GRPC_URL: BOX_PEER_GRPC.product,
    ACTIVITY_GRPC_URL: BOX_PEER_GRPC.activity,
    ORDERS_GRPC_URL: BOX_PEER_GRPC.orders,
    NOTIFICATION_GRPC_URL: BOX_PEER_GRPC.notification,
    DOCUMENTS_GRPC_URL: BOX_PEER_GRPC.documents,
    GATEWAY_SERVICE_API_KEY: BOX_GATEWAY_SERVICE_API_KEY,
    JWT_SECRET: BOX_JWT_SECRET,
    AUTOMATION_SERVICE_API_KEY: deriveBoxAutomationServiceKey(),
    AUTOMATION_SECRET_KEY:
      process.env.AUTOMATION_SECRET_KEY ?? 'intclosure-docs-automation-secret-key-32b',
    AUTOMATION_EXECUTOR_TIMEOUT_MS: '60000',
    AUTOMATION_TRIGGER_QUEUE: 'intclosure-docs.automation.triggers',
    GRPC_REFLECTION_ENABLED: 'false',
    LOG_LEVEL: 'error',
    ...overrides,
  };
}

/** Env for local product wired to the box stand stores/peers + local orders gRPC. */
export function localProductServiceEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    HTTP_PORT: '13007',
    GRPC_PRODUCT_PORT: '15007',
    MONGODB_URI: BOX_MONGODB_URI,
    RABBITMQ_URL: BOX_RABBITMQ_URL,
    AUTH_GRPC_URL: BOX_PEER_GRPC.auth,
    CONTROL_GRPC_URL: BOX_PEER_GRPC.control,
    PIPE_GRPC_URL: BOX_PEER_GRPC.pipe,
    ORDERS_GRPC_URL: LOCAL_ORDERS_GRPC_URL,
    GATEWAY_SERVICE_API_KEY: BOX_GATEWAY_SERVICE_API_KEY,
    PRODUCT_SERVICE_API_KEY: BOX_GATEWAY_SERVICE_API_KEY,
    JWT_SECRET: BOX_JWT_SECRET,
    GRPC_REFLECTION_ENABLED: 'false',
    PROJECT_PURGE_CONSUMERS_ENABLED: 'false',
    ...overrides,
  };
}

/** Env block for spawning local documents against the box stand peers (no S3 — chat gate only). */
export function localDocumentsServiceEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    HTTP_PORT: '13010',
    GRPC_DOCUMENTS_PORT: '15010',
    MONGODB_URI: BOX_MONGODB_URI,
    RABBITMQ_URL: BOX_RABBITMQ_URL,
    AUTH_GRPC_URL: BOX_PEER_GRPC.auth,
    CONTROL_GRPC_URL: BOX_PEER_GRPC.control,
    CHAT_GRPC_URL: BOX_PEER_GRPC.chat,
    GATEWAY_SERVICE_API_KEY: BOX_GATEWAY_SERVICE_API_KEY,
    JWT_SECRET: BOX_JWT_SECRET,
    GRPC_REFLECTION_ENABLED: 'false',
    LOG_LEVEL: 'error',
    PROJECT_PURGE_CONSUMERS_ENABLED: 'false',
    ...overrides,
  };
}

/** Env block for spawning the local control service against the box stand peers + stores. */
export function localControlServiceEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    PORT: '3002',
    GRPC_PORT: '5002',
    HOST: '0.0.0.0',
    DATABASE_URL: BOX_POSTGRES_URL,
    DIRECT_URL: BOX_POSTGRES_URL,
    RABBITMQ_URL: BOX_RABBITMQ_URL,
    AUTH_GRPC_URL: BOX_PEER_GRPC.auth,
    PIPE_GRPC_URL: BOX_PEER_GRPC.pipe,
    ORDERS_GRPC_URL: BOX_PEER_GRPC.orders,
    DOCUMENTS_GRPC_URL: BOX_PEER_GRPC.documents,
    AUTOMATION_GRPC_URL: BOX_PEER_GRPC.automation,
    GATEWAY_SERVICE_API_KEY: BOX_GATEWAY_SERVICE_API_KEY,
    JWT_SECRET: BOX_JWT_SECRET,
    GRPC_REFLECTION_ENABLED: 'false',
    CONTROL_OUTBOX_DISABLED: 'false',
    PROJECT_PURGE_DISABLED: 'false',
    PROJECT_PURGE_INTERVAL_MS: '2000',
    PROJECT_PURGE_GRACE_DAYS: '0',
    ...overrides,
  };
}

/** Env block for spawning local gateway against the box stand peers + stores. */
export function localGatewayServiceEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    LISTEN_PORT: '13000',
    HOST: '0.0.0.0',
    DATABASE_URL: BOX_POSTGRES_URI,
    DIRECT_URL: BOX_POSTGRES_URI,
    RABBITMQ_URL: BOX_RABBITMQ_URL,
    REDIS_URL: BOX_REDIS_URL,
    AUTH_GRPC_URL: BOX_PEER_GRPC.auth,
    CONTROL_GRPC_URL: BOX_PEER_GRPC.control,
    CONTACT_GRPC_URL: BOX_PEER_GRPC.contact,
    COMPANY_GRPC_URL: BOX_PEER_GRPC.company,
    PIPE_GRPC_URL: BOX_PEER_GRPC.pipe,
    ORDERS_GRPC_URL: BOX_PEER_GRPC.orders,
    PRODUCT_GRPC_URL: BOX_PEER_GRPC.product,
    ACTIVITY_GRPC_URL: BOX_PEER_GRPC.activity,
    DOCUMENTS_GRPC_URL: BOX_PEER_GRPC.documents,
    REPORTS_GRPC_URL: `${BOX_HOST}:5011`,
    AUTOMATION_GRPC_URL: BOX_PEER_GRPC.automation,
    SEARCH_GRPC_URL: `${BOX_HOST}:5013`,
    AUDIT_GRPC_URL: BOX_PEER_GRPC.audit,
    NOTIFICATION_GRPC_URL: BOX_PEER_GRPC.notification,
    BILLING_GRPC_URL: `${BOX_HOST}:5016`,
    CHAT_GRPC_URL: BOX_PEER_GRPC.chat,
    GATEWAY_SERVICE_API_KEY: BOX_GATEWAY_SERVICE_API_KEY,
    JWT_SECRET: BOX_JWT_SECRET,
    GATEWAY_EVENTS_ENABLED: 'true',
    GATEWAY_PROJECT_ACCESS_ENFORCE: 'true',
    LOG_LEVEL: 'error',
    ...overrides,
  };
}
