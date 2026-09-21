import { connect } from 'node:net';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { Metadata } from '@grpc/grpc-js';
import { serializeVisibilityScope } from '@fairflow/shared';
import { buildGatewayMetadata, type GatewayMetadataContext } from '../metadata';
import { BOX_GATEWAY_SERVICE_API_KEY, LOCAL_PRODUCT_GRPC_URL } from './conn';

const ALL_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

function resolveProductProtoPath(): string {
  const candidates = [
    join(process.cwd(), '..', 'proto', 'fairflow', 'product', 'v1', 'product.proto'),
    join(process.cwd(), 'proto', 'fairflow', 'product', 'v1', 'product.proto'),
    join(__dirname, '..', '..', '..', 'proto', 'fairflow', 'product', 'v1', 'product.proto'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`product.proto not found (cwd=${process.cwd()})`);
}

export interface LocalProductGrpcClient {
  deleteProduct(
    req: Record<string, unknown>,
    ctx: GatewayMetadataContext,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

function promisify<T>(
  fn: (req: Record<string, unknown>, md: Metadata, cb: grpc.requestCallback<T>) => void,
  req: Record<string, unknown>,
  md: Metadata,
): Promise<T> {
  return new Promise((resolve, reject) => {
    fn(req, md, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

export function createLocalProductGrpcClient(
  url = LOCAL_PRODUCT_GRPC_URL,
): LocalProductGrpcClient {
  const protoPath = resolveProductProtoPath();
  const includeDir = join(protoPath, '..', '..', '..', '..');
  const def = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [includeDir],
  });
  const pkg = grpc.loadPackageDefinition(def) as Record<string, unknown>;
  const svc = (
    (pkg.fairflow as Record<string, unknown>).product as Record<string, unknown>
  ).v1 as Record<string, grpc.ServiceClientConstructor>;
  const Client = svc.ProductGrpc;
  const client = new Client(url, grpc.credentials.createInsecure()) as unknown as Record<
    string,
    (req: Record<string, unknown>, md: Metadata, cb: grpc.requestCallback<Record<string, unknown>>) => void
  > & { close?: () => void };

  const mdFor = (ctx: GatewayMetadataContext): Metadata =>
    buildGatewayMetadata({
      serviceApiKey: BOX_GATEWAY_SERVICE_API_KEY,
      roles: ['owner'],
      permissions: [
        'contacts:read',
        'contacts:write',
        'companies:read',
        'companies:write',
        'deals:read',
        'deals:write',
        'products:read',
        'products:write',
        'products:delete',
        'orders:read',
        'orders:write',
        'orders:move',
        'orders:manage',
        'orders:cancel',
        'automation:read',
        'automation:write',
        'automation:execute',
        'automation:manage',
      ],
      enabledModules: [
        'contacts',
        'companies',
        'deals',
        'products',
        'orders',
        'search',
        'automation',
        'activities',
      ],
      visibilityScope: ALL_SCOPE,
      ...ctx,
    });

  return {
    deleteProduct: (req, ctx) => promisify(client.DeleteProduct.bind(client), req, mdFor(ctx)),
    close: () => client.close?.(),
  };
}

/** Wait until local product gRPC accepts connections. */
export async function waitForProductGrpc(
  url = LOCAL_PRODUCT_GRPC_URL,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const [, hostPort] = url.includes('://') ? ['', url.split('://')[1]] : ['', url];
  const [host, portStr] = hostPort.split(':');
  const port = Number(portStr || 15007);
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host, port }, () => {
          socket.end();
          resolve();
        });
        socket.on('error', reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`product gRPC not reachable at ${url} within ${timeoutMs}ms`);
}
