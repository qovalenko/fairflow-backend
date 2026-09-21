import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

type UnaryClient = Record<string, (...args: unknown[]) => unknown>;

function servicesRoot(): string {
  const candidates = [
    join(process.cwd(), '..'),
    join(process.cwd(), '../..'),
    join(__dirname, '..', '..', '..'),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, 'proto', 'fairflow'))) return p;
  }
  return join(__dirname, '..', '..', '..');
}

function resolveProtoPath(...segments: string[]): string {
  return join(servicesRoot(), 'proto', 'fairflow', ...segments);
}

function loadGrpcClient(protoRel: string[], servicePath: string[], url: string): UnaryClient {
  const protoPath = resolveProtoPath(...protoRel);
  const includeDir = join(servicesRoot(), 'proto');
  const def = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [includeDir],
  });
  const pkg = grpc.loadPackageDefinition(def) as Record<string, unknown>;
  let cur: unknown = pkg;
  for (const seg of servicePath.slice(0, -1)) {
    cur = (cur as Record<string, unknown>)[seg];
  }
  const Service = (cur as Record<string, grpc.ServiceClientConstructor>)[
    servicePath[servicePath.length - 1]
  ];
  return new Service(url, grpc.credentials.createInsecure()) as unknown as UnaryClient;
}

/** Raw ContactGrpc client for s2s probes (custom metadata / deadlines). */
export function loadContactGrpcRaw(url: string): UnaryClient {
  return loadGrpcClient(
    ['contact', 'v1', 'contact.proto'],
    ['fairflow', 'contact', 'v1', 'ContactGrpc'],
    url,
  );
}
