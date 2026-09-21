import { connect } from 'node:net';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { Metadata } from '@grpc/grpc-js';
import { serializeVisibilityScope } from '@fairflow/shared';
import { buildGatewayMetadata, type GatewayMetadataContext } from '../metadata';
import { BOX_GATEWAY_SERVICE_API_KEY, LOCAL_ORDERS_GRPC_URL } from './conn';

const ALL_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

function resolveOrdersProtoPath(): string {
  const candidates = [
    join(process.cwd(), '..', 'proto', 'fairflow', 'orders', 'v1', 'orders.proto'),
    join(process.cwd(), 'proto', 'fairflow', 'orders', 'v1', 'orders.proto'),
    join(__dirname, '..', '..', '..', 'proto', 'fairflow', 'orders', 'v1', 'orders.proto'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`orders.proto not found (cwd=${process.cwd()})`);
}

export interface OrdersGrpcClient {
  createOrderType(
    req: Record<string, unknown>,
    ctx: GatewayMetadataContext,
  ): Promise<Record<string, unknown>>;
  createOrder(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  getOrder(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  updateOrder(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  moveOrderToStage(
    req: Record<string, unknown>,
    ctx: GatewayMetadataContext,
  ): Promise<Record<string, unknown>>;
  cancelOrder(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  checkDrift(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  resolveDocumentVariables(
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

export function createOrdersGrpcClient(url = LOCAL_ORDERS_GRPC_URL): OrdersGrpcClient {
  const protoPath = resolveOrdersProtoPath();
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
    (pkg.fairflow as Record<string, unknown>).orders as Record<string, unknown>
  ).v1 as Record<string, grpc.ServiceClientConstructor>;
  const Client = svc.OrdersGrpc;
  const client = new Client(url, grpc.credentials.createInsecure()) as unknown as Record<
    string,
    (req: Record<string, unknown>, md: Metadata, cb: grpc.requestCallback<Record<string, unknown>>) => void
  > & { close?: () => void };

  const mdFor = (ctx: GatewayMetadataContext): Metadata =>
    buildGatewayMetadata({
      serviceApiKey: BOX_GATEWAY_SERVICE_API_KEY,
      roles: ['owner'],
      permissions: [
        'orders:read',
        'orders:write',
        'orders:move',
        'orders:manage',
        'orders:cancel',
        'documents:read',
      ],
      enabledModules: ['contacts', 'companies', 'deals', 'products', 'orders', 'search', 'automation'],
      visibilityScope: ALL_SCOPE,
      ...ctx,
    });

  return {
    createOrderType: (req, ctx) =>
      promisify(client.CreateOrderType.bind(client), req, mdFor(ctx)),
    createOrder: (req, ctx) => promisify(client.CreateOrder.bind(client), req, mdFor(ctx)),
    getOrder: (req, ctx) => promisify(client.GetOrder.bind(client), req, mdFor(ctx)),
    updateOrder: (req, ctx) => promisify(client.UpdateOrder.bind(client), req, mdFor(ctx)),
    moveOrderToStage: (req, ctx) =>
      promisify(client.MoveOrderToStage.bind(client), req, mdFor(ctx)),
    cancelOrder: (req, ctx) => promisify(client.CancelOrder.bind(client), req, mdFor(ctx)),
    checkDrift: (req, ctx) => promisify(client.CheckDrift.bind(client), req, mdFor(ctx)),
    resolveDocumentVariables: (req, ctx) =>
      promisify(client.ResolveDocumentVariables.bind(client), req, mdFor(ctx)),
    close: () => client.close?.(),
  };
}

/** Wait until local orders gRPC accepts connections. */
export async function waitForOrdersGrpc(
  url = LOCAL_ORDERS_GRPC_URL,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const [, hostPort] = url.includes('://') ? ['', url.split('://')[1]] : ['', url];
  const [host, portStr] = hostPort.split(':');
  const port = Number(portStr || 5006);
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
  throw new Error(`orders gRPC not reachable at ${url} within ${timeoutMs}ms`);
}
