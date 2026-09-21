import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { LOCAL_PRODUCT_GRPC_URL, localProductServiceEnv } from './conn';
import { waitForProductGrpc } from './product-grpc-client';

let child: ChildProcess | null = null;

function localProductPort(): number {
  const hostPort = LOCAL_PRODUCT_GRPC_URL.split(':').pop() ?? '15007';
  const port = Number(hostPort);
  return Number.isFinite(port) ? port : 15007;
}

function killStaleProductOnPort(): void {
  const port = localProductPort();
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

/** Spawn local product (prod build) wired to the box stand + local orders gRPC. */
export async function startLocalProductService(): Promise<void> {
  if (child) {
    try {
      await waitForProductGrpc(undefined, 2_000);
      return;
    } catch {
      await stopLocalProductService();
    }
  }
  killStaleProductOnPort();
  const root = backendRoot();
  const productDir = join(root, 'product');
  child = spawn('node', ['dist/main.js'], {
    cwd: productDir,
    env: localProductServiceEnv(),
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
      console.error(`local product exited with code ${code}`);
    }
    child = null;
  });
  await waitForProductGrpc();
}

/** Restart local product if the gRPC port dropped. */
export async function ensureLocalProductService(): Promise<void> {
  if (child && !child.killed) {
    try {
      await waitForProductGrpc(undefined, 2_000);
      return;
    } catch {
      /* restart below */
    }
  }
  await stopLocalProductService();
  await startLocalProductService();
}

export async function stopLocalProductService(): Promise<void> {
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
  killStaleProductOnPort();
}
