import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  credentials,
  loadPackageDefinition,
  Metadata,
  type Client,
  type ServiceClientConstructor,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { serializeVisibilityScope } from '@fairflow/shared';
import { buildGatewayMetadata, type GatewayMetadataContext } from '../metadata';
import { BOX_GATEWAY_SERVICE_API_KEY, LOCAL_CONTACT_GRPC_URL } from './conn';

const ALL_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

type UnaryClient = Client & Record<string, (...args: unknown[]) => unknown>;

function resolveContactProtoPath(): string {
  const candidates = [
    join(process.cwd(), '..', 'proto', 'fairflow', 'contact', 'v1', 'contact.proto'),
    join(process.cwd(), 'proto', 'fairflow', 'contact', 'v1', 'contact.proto'),
    join(__dirname, '..', '..', '..', 'proto', 'fairflow', 'contact', 'v1', 'contact.proto'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`contact.proto not found (cwd=${process.cwd()})`);
}

function promisifyUnary<TReq, TRes>(
  client: UnaryClient,
  method: string,
): (req: TReq, metadata?: Metadata) => Promise<TRes> {
  const fn = client[method];
  if (typeof fn !== 'function') {
    throw new Error(`gRPC method ${method} not found on client`);
  }
  const bound = fn.bind(client) as (
    req: TReq,
    md: Metadata,
    cb: (err: Error | null, res: TRes) => void,
  ) => void;
  return (req, metadata = new Metadata()) =>
    new Promise<TRes>((resolve, reject) => {
      bound(req, metadata, (err, res) => (err ? reject(err) : resolve(res)));
    });
}

function loadContactClient(url: string): UnaryClient {
  const protoPath = resolveContactProtoPath();
  const includeDir = join(protoPath, '..', '..', '..', '..');
  const def = loadSync(protoPath, {
    keepCase: true,
    longs: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [includeDir],
  });
  const pkg = loadPackageDefinition(def) as Record<string, unknown>;
  const Service = (
    (pkg.fairflow as Record<string, unknown>).contact as Record<string, unknown>
  ).v1 as Record<string, ServiceClientConstructor>;
  const ClientCtor = Service.ContactGrpc;
  return new ClientCtor(url, credentials.createInsecure()) as UnaryClient;
}

export interface ContactGrpcClient {
  createContact(
    req: Record<string, unknown>,
    ctx: GatewayMetadataContext,
  ): Promise<Record<string, unknown>>;
  updateContact(
    req: Record<string, unknown>,
    ctx: GatewayMetadataContext,
  ): Promise<Record<string, unknown>>;
  deleteContact(
    req: Record<string, unknown>,
    ctx: GatewayMetadataContext,
  ): Promise<Record<string, unknown>>;
  getContact(
    req: Record<string, unknown>,
    ctx: GatewayMetadataContext,
  ): Promise<Record<string, unknown>>;
  mergeContacts(
    req: Record<string, unknown>,
    ctx: GatewayMetadataContext,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

export function createContactGrpcClient(url = LOCAL_CONTACT_GRPC_URL): ContactGrpcClient {
  const raw = loadContactClient(url);

  const mdFor = (ctx: GatewayMetadataContext): Metadata =>
    buildGatewayMetadata({
      serviceApiKey: BOX_GATEWAY_SERVICE_API_KEY,
      roles: ['owner'],
      permissions: ['contacts:read', 'contacts:write', 'contacts:delete', 'contacts:merge'],
      enabledModules: ['contacts', 'companies', 'deals', 'orders', 'activities'],
      visibilityScope: ALL_SCOPE,
      ...ctx,
    });

  const call =
    (method: string) =>
    (req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>> =>
      promisifyUnary<Record<string, unknown>, Record<string, unknown>>(raw, method)(req, mdFor(ctx));

  return {
    createContact: call('CreateContact'),
    updateContact: call('UpdateContact'),
    deleteContact: call('DeleteContact'),
    getContact: call('GetContact'),
    mergeContacts: call('MergeContacts'),
    close: () => raw.close(),
  };
}

/** Wait until local contact gRPC accepts TCP connections. */
export async function waitForContactGrpc(url = LOCAL_CONTACT_GRPC_URL, timeoutMs = 90_000): Promise<void> {
  const [, hostPort] = url.includes('://') ? ['', url.split('://')[1]] : ['', url];
  const [host, portStr] = hostPort.split(':');
  const port = Number(portStr || 5003);
  const deadline = Date.now() + timeoutMs;
  const net = await import('node:net');
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.createConnection({ host, port }, () => {
          s.end();
          resolve();
        });
        s.on('error', reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`contact gRPC not reachable at ${url} within ${timeoutMs}ms`);
}
