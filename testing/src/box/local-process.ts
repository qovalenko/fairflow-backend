import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { localDocumentsServiceEnv, localGatewayServiceEnv, LOCAL_DOCUMENTS_GRPC_URL } from './conn';
import { waitForGrpcPort, waitForHttpOk } from './grpc-clients';

let documentsChild: ChildProcess | null = null;
let gatewayChild: ChildProcess | null = null;

function backendRoot(): string {
  if (
    process.cwd().endsWith('/automation') ||
    process.cwd().endsWith('/documents') ||
    process.cwd().endsWith('/gateway')
  ) {
    return join(process.cwd(), '..');
  }
  return join(process.cwd(), '..');
}

function spawnService(
  name: string,
  dir: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (buf) => {
    if (process.env.BOX_INTEGRATION_VERBOSE === '1') process.stdout.write(`[${name}] ${buf}`);
  });
  child.stderr.on('data', (buf) => {
    if (process.env.BOX_INTEGRATION_VERBOSE === '1') process.stderr.write(`[${name}] ${buf}`);
  });
  child.on('exit', (code) => {
    if (code && code !== 0 && process.env.BOX_INTEGRATION_VERBOSE === '1') {
      console.error(`local ${name} exited with code ${code}`);
    }
  });
  return child;
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 10_000);
    child.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export async function startLocalDocumentsService(): Promise<void> {
  if (documentsChild) return;
  const root = backendRoot();
  documentsChild = spawnService('documents', join(root, 'documents'), localDocumentsServiceEnv());
  await waitForGrpcPort(LOCAL_DOCUMENTS_GRPC_URL);
}

export async function stopLocalDocumentsService(): Promise<void> {
  const proc = documentsChild;
  documentsChild = null;
  await stopChild(proc);
}

export async function startLocalGatewayService(): Promise<void> {
  if (gatewayChild) return;
  const root = backendRoot();
  try {
    const { execSync } = await import('node:child_process');
    execSync('fuser -k 13000/tcp 2>/dev/null || true', { stdio: 'ignore' });
  } catch {
    /* best-effort */
  }
  gatewayChild = spawnService('gateway', join(root, 'gateway'), localGatewayServiceEnv());
  await waitForHttpOk('http://127.0.0.1:13000/healthz', 120_000);
}

export async function stopLocalGatewayService(): Promise<void> {
  const proc = gatewayChild;
  gatewayChild = null;
  await stopChild(proc);
}
