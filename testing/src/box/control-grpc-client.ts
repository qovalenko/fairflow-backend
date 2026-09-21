import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { Metadata } from '@grpc/grpc-js';
import { buildServiceMetadata } from '../metadata';
import { BOX_GATEWAY_SERVICE_API_KEY, LOCAL_CONTROL_GRPC_URL } from './conn';

function resolveControlProtoPath(): string {
  const candidates = [
    join(process.cwd(), '..', 'proto', 'fairflow', 'control', 'v1', 'control.proto'),
    join(process.cwd(), 'proto', 'fairflow', 'control', 'v1', 'control.proto'),
    join(__dirname, '..', '..', '..', 'proto', 'fairflow', 'control', 'v1', 'control.proto'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`control.proto not found (cwd=${process.cwd()})`);
}

export interface ControlGrpcClient {
  deactivateEmployee(req: {
    user_id: string;
    actor_user_id: string;
    reassign_to_user_id?: string;
  }): Promise<Record<string, unknown>>;
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

export function createControlGrpcClient(url = LOCAL_CONTROL_GRPC_URL): ControlGrpcClient {
  const protoPath = resolveControlProtoPath();
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
    (pkg.fairflow as Record<string, unknown>).control as Record<string, unknown>
  ).v1 as Record<string, grpc.ServiceClientConstructor>;
  const Client = svc.OrganizationGrpc;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = new Client(url, grpc.credentials.createInsecure()) as any;

  const md = (): Metadata => buildServiceMetadata(BOX_GATEWAY_SERVICE_API_KEY);

  return {
    deactivateEmployee: (req) =>
      promisify(client.DeactivateEmployee.bind(client), req, md()),
    close: () => {
      if (typeof client.close === 'function') client.close();
    },
  };
}

/** Wait until local control gRPC accepts connections. */
export async function waitForControlGrpc(
  url = LOCAL_CONTROL_GRPC_URL,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const [, hostPort] = url.includes('://') ? ['', url.split('://')[1]] : ['', url];
  const [host, portStr] = hostPort.split(':');
  const port = Number(portStr || 5002);
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const client = new grpc.Client(`${host}:${port}`, grpc.credentials.createInsecure());
        client.waitForReady(Date.now() + 2000, (err) => {
          client.close();
          if (err) reject(err);
          else resolve();
        });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`control gRPC not reachable at ${url} within ${timeoutMs}ms`);
}
