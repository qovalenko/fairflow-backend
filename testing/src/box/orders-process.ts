import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { LOCAL_ORDERS_GRPC_URL, localOrdersServiceEnv } from './conn';
import { waitForOrdersGrpc } from './orders-grpc-client';

let child: ChildProcess | null = null;

function localOrdersPort(): number {
  const hostPort = LOCAL_ORDERS_GRPC_URL.split(':').pop() ?? '5006';
  const port = Number(hostPort);
  return Number.isFinite(port) ? port : 5006;
}

/** Kill any process bound to the local orders gRPC port (orphans after crashed jest runs). */
function killStaleOrdersOnPort(): void {
  const port = localOrdersPort();
  try {
    const pids = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (!pids) return;
    for (const pid of pids.split(/\s+/)) {
      if (!pid) continue;
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* port free or lsof unavailable */
  }
}

function backendRoot(): string {
  if (process.cwd().endsWith('/orders')) return join(process.cwd(), '..');
  return join(process.cwd(), '..');
}

/** Spawn local orders service (prod build) wired to the box stand peers/stores. */
export async function startLocalOrdersService(): Promise<void> {
  if (child) {
    try {
      await waitForOrdersGrpc(undefined, 2_000);
      return;
    } catch {
      await stopLocalOrdersService();
    }
  }
  killStaleOrdersOnPort();
  const root = backendRoot();
  const ordersDir = join(root, 'orders');
  child = spawn('node', ['dist/main.js'], {
    cwd: ordersDir,
    env: localOrdersServiceEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const proc = child;
  proc.stdout?.on('data', (buf) => {
    if (process.env.BOX_INTEGRATION_VERBOSE === '1') process.stdout.write(buf);
  });
  proc.stderr?.on('data', (buf) => {
    if (process.env.BOX_INTEGRATION_VERBOSE === '1') process.stderr.write(buf);
  });
  proc.on('exit', (code) => {
    if (code && code !== 0 && process.env.BOX_INTEGRATION_VERBOSE === '1') {
      console.error(`local orders exited with code ${code}`);
    }
    child = null;
  });
  await waitForOrdersGrpc();
}

/** Restart local orders if the gRPC port dropped (long the box stand waits can coincide with process exit). */
export async function ensureLocalOrdersService(): Promise<void> {
  try {
    await waitForOrdersGrpc(undefined, 2_000);
    if (child && !child.killed) return;
  } catch {
    /* restart below */
  }
  await stopLocalOrdersService();
  await startLocalOrdersService();
}

export async function stopLocalOrdersService(): Promise<void> {
  if (child) {
    const proc = child;
    child = null;
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 10_000);
      proc.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  killStaleOrdersOnPort();
}
