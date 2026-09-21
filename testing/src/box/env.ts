/**
 * Box stand integration harness env (integration-closure waves — BFF, money, offboard).
 *
 * Skips unless BOX_INTEGRATION=1. Applies connection-kit URLs so locally-bootstrapped
 * gateway/control talks to the box stand peers.
 */

const BOX_HOST = process.env.BOX_HOST ?? 'localhost';

export const BOX_CONN = {
  host: BOX_HOST,
  postgres:
    process.env.DATABASE_URL ??
    `postgresql://fairflow:CHANGE_ME@${BOX_HOST}:5432/fairflow`,
  redis:
    process.env.REDIS_URL ??
    `redis://:CHANGE_ME@${BOX_HOST}:16379`,
  gatewayHttp: process.env.GATEWAY_HTTP_URL ?? `http://${BOX_HOST}:3000`,
  gatewayServiceApiKey:
    process.env.GATEWAY_SERVICE_API_KEY ?? 'ak_CHANGE_ME',
  jwtSecret:
    process.env.JWT_SECRET ?? 'CHANGE_ME',
  grpc: {
    auth: process.env.AUTH_GRPC_URL ?? `${BOX_HOST}:5001`,
    control: process.env.CONTROL_GRPC_URL ?? `${BOX_HOST}:5002`,
    contact: process.env.CONTACT_GRPC_URL ?? `${BOX_HOST}:5003`,
    company: process.env.COMPANY_GRPC_URL ?? `${BOX_HOST}:5004`,
    pipe: process.env.PIPE_GRPC_URL ?? `${BOX_HOST}:5005`,
    orders: process.env.ORDERS_GRPC_URL ?? `${BOX_HOST}:5006`,
    product: process.env.PRODUCT_GRPC_URL ?? `${BOX_HOST}:5007`,
    activity: process.env.ACTIVITY_GRPC_URL ?? `${BOX_HOST}:5008`,
    documents: process.env.DOCUMENTS_GRPC_URL ?? `${BOX_HOST}:5010`,
    reports: process.env.REPORTS_GRPC_URL ?? `${BOX_HOST}:5011`,
    automation: process.env.AUTOMATION_GRPC_URL ?? `${BOX_HOST}:5012`,
    search: process.env.SEARCH_GRPC_URL ?? `${BOX_HOST}:5013`,
    audit: process.env.AUDIT_GRPC_URL ?? `${BOX_HOST}:5014`,
    notification: process.env.NOTIFICATION_GRPC_URL ?? `${BOX_HOST}:5015`,
    chat: process.env.CHAT_GRPC_URL ?? `${BOX_HOST}:5016`,
  },
  mongodb:
    process.env.BOX_MONGODB_URI ??
    `mongodb://root:CHANGE_ME@${BOX_HOST}:27017/fairflow?authSource=admin`,
  rabbitmq:
    process.env.RABBITMQ_URL ??
    `amqp://fairflow:CHANGE_ME@${BOX_HOST}:5672/`,
} as const;

function resolveBoxDataPrefix(): string {
  return process.env.BOX_DATA_PREFIX ?? 'intclosure-bff-';
}

/** Prefix for entities created by box integration specs (data isolation). */
export const BOX_DATA_PREFIX = resolveBoxDataPrefix();

export function hasBoxIntegration(): boolean {
  return process.env.BOX_INTEGRATION === '1';
}

export const describeBoxIntegration: jest.Describe = ((
  name: string,
  fn: jest.EmptyFunction,
) => {
  (hasBoxIntegration() ? describe : describe.skip)(name, fn);
}) as jest.Describe;

export interface ApplyBoxEnvOptions {
  /** Local control gRPC bind port (peers stay on the box stand). */
  controlGrpcPort?: number;
  /** Local control HTTP port (health only). */
  controlHttpPort?: number;
}

export interface ApplyGatewayBoxEnvOptions {
  gatewayHttpPort?: number;
}

/**
 * Hosts probed for the box stand's MinIO. Defaults to BOX_HOST only; add more
 * via BOX_S3_PROBE_HOST (comma-separated) when the stand splits S3 off the app host.
 */
export const BOX_S3_PROBE_HOSTS = [
  BOX_HOST,
  ...(process.env.BOX_S3_PROBE_HOST?.split(',').map((h) => h.trim()).filter(Boolean) ?? []),
] as const;

/** Ports probed for the box stand MinIO (connection kit may add one later). */
export const BOX_S3_PROBE_PORTS = [
  9000, 9001, 9090, 19000, 19001, 30900, 30901, 32000, 32001,
  30090, 32700, 32701, 443, 8443,
] as const;

let boxS3ReachableCache: boolean | undefined;

export interface BoxS3ProbeResult {
  endpoint: string | null;
  healthOk: boolean;
  credentialsOk: boolean;
  accessKeyId: string;
  error?: string;
}

/** Detailed MinIO probe for setup logging (does not mutate env). */
export async function probeBoxS3Detailed(): Promise<BoxS3ProbeResult> {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? 'minioadmin';
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin';
  const candidates: string[] = [];
  const explicit = process.env.S3_ENDPOINT?.trim();
  if (explicit && !/127\.0\.0\.1|localhost/.test(explicit)) candidates.push(explicit);
  for (const host of BOX_S3_PROBE_HOSTS) {
    for (const port of BOX_S3_PROBE_PORTS) {
      candidates.push(`http://${host}:${port}`);
    }
  }

  for (const endpoint of candidates) {
    const healthOk = await probeEndpointHealth(endpoint);
    if (!healthOk) continue;
    const credentialsOk = await probeS3Credentials(endpoint, accessKeyId, secretAccessKey);
    if (credentialsOk) {
      return { endpoint, healthOk: true, credentialsOk: true, accessKeyId };
    }
    return {
      endpoint,
      healthOk: true,
      credentialsOk: false,
      accessKeyId,
      error: 'S3 credentials rejected (ListBuckets failed)',
    };
  }

  return { endpoint: null, healthOk: false, credentialsOk: false, accessKeyId };
}

function applyBoxS3Env(endpoint: string): void {
  process.env.BOX_S3_INTEGRATION = '1';
  process.env.S3_ENDPOINT = endpoint;
  process.env.S3_REGION = process.env.S3_REGION ?? 'us-east-1';
  process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? 'minioadmin';
  process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin';
  process.env.S3_DOCUMENTS_BUCKET = process.env.S3_DOCUMENTS_BUCKET ?? 'fairflow-documents';
  process.env.S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE ?? 'true';
}

async function probeEndpointHealth(endpoint: string): Promise<boolean> {
  const base = endpoint.replace(/\/$/, '');
  const paths = ['/minio/health/live', '/minio/health/ready'];
  for (const path of paths) {
    try {
      const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) return true;
    } catch {
      /* try next path / port */
    }
  }
  return false;
}

async function probeS3Credentials(
  endpoint: string,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<boolean> {
  try {
    // Resolved from the monorepo root — gateway already depends on @aws-sdk/client-s3.
    const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3') as typeof import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    await client.send(new ListBucketsCommand({}));
    return true;
  } catch {
    return false;
  }
}

async function probeEndpointWithCredentials(endpoint: string): Promise<boolean> {
  if (!(await probeEndpointHealth(endpoint))) return false;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? 'minioadmin';
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin';
  return probeS3Credentials(endpoint, accessKeyId, secretAccessKey);
}

/**
 * Probe the box stand MinIO and wire S3 env when reachable.
 * Call from jest setupFiles (before spec module load) or before booting local gateway.
 */
export async function probeAndApplyBoxS3Env(): Promise<boolean> {
  if (process.env.BOX_S3_INTEGRATION === '1') {
    const endpoint = process.env.S3_ENDPOINT ?? `http://${BOX_HOST}:9000`;
    if (await probeEndpointWithCredentials(endpoint)) {
      applyBoxS3Env(endpoint);
      boxS3ReachableCache = true;
      return true;
    }
    boxS3ReachableCache = false;
    return false;
  }

  const explicit = process.env.S3_ENDPOINT?.trim();
  if (explicit && !/127\.0\.0\.1|localhost/.test(explicit)) {
    if (await probeEndpointWithCredentials(explicit)) {
      applyBoxS3Env(explicit);
      boxS3ReachableCache = true;
      return true;
    }
  }

  for (const host of BOX_S3_PROBE_HOSTS) {
    for (const port of BOX_S3_PROBE_PORTS) {
      const endpoint = `http://${host}:${port}`;
      if (await probeEndpointWithCredentials(endpoint)) {
        applyBoxS3Env(endpoint);
        boxS3ReachableCache = true;
        return true;
      }
    }
  }

  boxS3ReachableCache = false;
  return false;
}

/** Whether the configured S3 endpoint responds (needed for gateway multipart uploads). */
export async function isBoxS3Reachable(): Promise<boolean> {
  if (boxS3ReachableCache !== undefined) return boxS3ReachableCache;
  const endpoint = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000';
  if (/127\.0\.0\.1|localhost/.test(endpoint) && process.env.BOX_S3_INTEGRATION !== '1') {
    boxS3ReachableCache = false;
    return false;
  }
  boxS3ReachableCache = await probeEndpointHealth(endpoint);
  return boxS3ReachableCache;
}

/** Wire process.env for local control + the box stand peers. Call before importing control AppModule. */
export function applyBoxEnv(opts: ApplyBoxEnvOptions = {}): void {
  const grpcPort =
    opts.controlGrpcPort ?? parseInt(process.env.GRPC_PORT ?? '15002', 10);
  const httpPort =
    opts.controlHttpPort ?? parseInt(process.env.PORT ?? '13002', 10);
  process.env.BOX_INTEGRATION = '1';
  process.env.DATABASE_URL = BOX_CONN.postgres;
  process.env.DIRECT_URL = BOX_CONN.postgres;
  process.env.GATEWAY_SERVICE_API_KEY = BOX_CONN.gatewayServiceApiKey;
  process.env.CONTROL_SERVICE_API_KEY = BOX_CONN.gatewayServiceApiKey;
  process.env.JWT_SECRET = BOX_CONN.jwtSecret;
  process.env.AUTH_GRPC_URL = BOX_CONN.grpc.auth;
  process.env.PIPE_GRPC_URL = BOX_CONN.grpc.pipe;
  process.env.ORDERS_GRPC_URL = BOX_CONN.grpc.orders;
  process.env.DOCUMENTS_GRPC_URL = BOX_CONN.grpc.documents;
  process.env.AUTOMATION_GRPC_URL = BOX_CONN.grpc.automation;
  process.env.CONTACT_GRPC_URL = BOX_CONN.grpc.contact;
  process.env.COMPANY_GRPC_URL = BOX_CONN.grpc.company;
  process.env.ACTIVITY_GRPC_URL = BOX_CONN.grpc.activity;
  process.env.RABBITMQ_URL = BOX_CONN.rabbitmq;
  process.env.CONTROL_OUTBOX_DISABLED = 'false';
  process.env.PROJECT_PURGE_DISABLED = 'false';
  process.env.PROJECT_PURGE_INTERVAL_MS = '2000';
  process.env.PROJECT_PURGE_GRACE_DAYS = '0';
  process.env.GRPC_PORT = String(grpcPort);
  process.env.PORT = String(httpPort);
  process.env.LISTEN_PORT = String(httpPort);
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
}

/** Wire process.env for local gateway + the box stand peers. Call before importing gateway AppModule. */
export function applyGatewayBoxEnv(opts: ApplyGatewayBoxEnvOptions = {}): void {
  const httpPort = opts.gatewayHttpPort ?? parseInt(process.env.PORT ?? '13000', 10);
  process.env.BOX_INTEGRATION = '1';
  process.env.DATABASE_URL = BOX_CONN.postgres;
  process.env.DIRECT_URL = BOX_CONN.postgres;
  process.env.GATEWAY_SERVICE_API_KEY = BOX_CONN.gatewayServiceApiKey;
  process.env.JWT_SECRET = BOX_CONN.jwtSecret;
  process.env.AUTH_GRPC_URL = BOX_CONN.grpc.auth;
  process.env.CONTROL_GRPC_URL = BOX_CONN.grpc.control;
  process.env.CONTACT_GRPC_URL = BOX_CONN.grpc.contact;
  process.env.COMPANY_GRPC_URL = BOX_CONN.grpc.company;
  process.env.PIPE_GRPC_URL = BOX_CONN.grpc.pipe;
  process.env.ORDERS_GRPC_URL = BOX_CONN.grpc.orders;
  process.env.PRODUCT_GRPC_URL = BOX_CONN.grpc.product;
  process.env.ACTIVITY_GRPC_URL = BOX_CONN.grpc.activity;
  process.env.DOCUMENTS_GRPC_URL = BOX_CONN.grpc.documents;
  process.env.REPORTS_GRPC_URL = BOX_CONN.grpc.reports;
  process.env.AUTOMATION_GRPC_URL = BOX_CONN.grpc.automation;
  process.env.SEARCH_GRPC_URL = BOX_CONN.grpc.search;
  process.env.AUDIT_GRPC_URL = BOX_CONN.grpc.audit;
  process.env.NOTIFICATION_GRPC_URL = BOX_CONN.grpc.notification;
  process.env.CHAT_GRPC_URL = BOX_CONN.grpc.chat;
  process.env.REDIS_URL = BOX_CONN.redis;
  process.env.PORT = String(httpPort);
  process.env.LISTEN_PORT = String(httpPort);
  process.env.HOST = '127.0.0.1';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'true';
  process.env.AUTH_SESSION_DENYLIST = 'false';
  process.env.TRUST_PROXY = 'true';
  if (process.env.BOX_S3_INTEGRATION === '1') {
    applyBoxS3Env(process.env.S3_ENDPOINT ?? `http://${BOX_HOST}:9000`);
  }
}

export function boxUniqueName(label: string): string {
  return `${resolveBoxDataPrefix()}${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Throwaway email for public auth routes (avoids shared platform-user rate limits). */
export function boxUniqueEmail(label = 'mail'): string {
  return `${resolveBoxDataPrefix()}${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
}

/** Unique RFC5737 TEST-NET-3 IP for public-auth throttle isolation (shared the box stand Redis). */
export function boxUniqueClientIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
}

const BOX_S3_BUG_SKIP_PREFIX =
  'BUG the box stand MinIO credentials rejected — upload returns 500 until S3 secret is in connection kit';

/** Jest `it` when the box stand MinIO was probed in setupFiles; BUG-skip when creds fail; else `it.skip`. */
export const boxItUpload: jest.It = ((name, fn, timeout) => {
  if (process.env.BOX_S3_INTEGRATION === '1') return it(name, fn, timeout);
  if (process.env.BOX_S3_CREDENTIALS_BUG === '1') {
    return it.skip(`${name} — ${BOX_S3_BUG_SKIP_PREFIX}`, fn, timeout);
  }
  return it.skip(name, fn, timeout);
}) as jest.It;

/** Drop cached gateway/src modules so Nest config is built after applyGatewayBoxEnv (Jest preloads .js). */
export function purgeGatewaySrcRequireCache(gatewaySrcRoot: string): void {
  const prefix = gatewaySrcRoot.endsWith('/') ? gatewaySrcRoot : `${gatewaySrcRoot}/`;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) delete require.cache[key];
  }
}
