import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { Metadata } from '@grpc/grpc-js';
import { serializeVisibilityScope } from '@fairflow/shared';
import { buildGatewayMetadata, type GatewayMetadataContext } from '../metadata';
import { BOX_GATEWAY_SERVICE_API_KEY, BOX_PEER_GRPC } from './conn';

const ALL_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

function resolveDocumentsProtoPath(): string {
  const candidates = [
    join(process.cwd(), '..', 'proto', 'fairflow', 'documents', 'v1', 'documents.proto'),
    join(process.cwd(), 'proto', 'fairflow', 'documents', 'v1', 'documents.proto'),
    join(__dirname, '..', '..', '..', 'proto', 'fairflow', 'documents', 'v1', 'documents.proto'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`documents.proto not found (cwd=${process.cwd()})`);
}

export interface DocumentsGrpcClient {
  generateDocument(
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

export function createDocumentsGrpcClient(url = BOX_PEER_GRPC.documents): DocumentsGrpcClient {
  const protoPath = resolveDocumentsProtoPath();
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
    (pkg.fairflow as Record<string, unknown>).documents as Record<string, unknown>
  ).v1 as Record<string, grpc.ServiceClientConstructor>;
  const Client = svc.DocumentsGrpc;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = new Client(url, grpc.credentials.createInsecure()) as any;

  const mdFor = (ctx: GatewayMetadataContext): Metadata =>
    buildGatewayMetadata({
      serviceApiKey: BOX_GATEWAY_SERVICE_API_KEY,
      roles: ['owner'],
      permissions: ['documents:read', 'documents:write', 'documents.generate:execute'],
      enabledModules: ['documents'],
      visibilityScope: ALL_SCOPE,
      ...ctx,
    });

  return {
    generateDocument: (req, ctx) =>
      promisify(client.GenerateDocument.bind(client), req, mdFor(ctx)),
    close: () => {
      if (typeof client.close === 'function') client.close();
    },
  };
}
