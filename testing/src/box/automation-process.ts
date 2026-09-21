import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { LOCAL_AUTOMATION_GRPC_URL, LOCAL_ORDERS_GRPC_URL, BOX_GATEWAY_SERVICE_API_KEY, localAutomationServiceEnv } from './conn';
import { waitForAutomationGrpc } from './automation-grpc-client';

let child: ChildProcess | null = null;

function localAutomationPort(): number {
  const hostPort = LOCAL_AUTOMATION_GRPC_URL.split(':').pop() ?? '15012';
  const port = Number(hostPort);
  return Number.isFinite(port) ? port : 15012;
}

function killStaleAutomationOnPort(): void {
  const port = localAutomationPort();
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

/** Spawn local automation (prod build) wired to the box stand + local orders gRPC. */
export async function startLocalAutomationService(): Promise<void> {
  if (child) {
    try {
      await waitForAutomationGrpc(undefined, 2_000);
      return;
    } catch {
      await stopLocalAutomationService();
    }
  }
  killStaleAutomationOnPort();
  const root = backendRoot();
  const automationDir = join(root, 'automation');
  child = spawn('node', ['dist/main.js'], {
    cwd: automationDir,
    env: localAutomationServiceEnv({
      ORDERS_GRPC_URL: LOCAL_ORDERS_GRPC_URL,
      AUTOMATION_SERVICE_API_KEY: BOX_GATEWAY_SERVICE_API_KEY,
      AUTOMATION_SECRET_KEY:
        process.env.AUTOMATION_SECRET_KEY ?? 'intclosure-local-automation-secret-32',
      AUTOMATION_TRIGGER_QUEUE: process.env.AUTOMATION_TRIGGER_QUEUE ?? 'automation.triggers',
    }),
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
      console.error(`local automation exited with code ${code}`);
    }
    child = null;
  });
  await waitForAutomationGrpc();
}

/** Restart local automation if the gRPC port dropped. */
export async function ensureLocalAutomationService(): Promise<void> {
  if (child && !child.killed) {
    try {
      await waitForAutomationGrpc(undefined, 2_000);
      return;
    } catch {
      /* restart below */
    }
  }
  await stopLocalAutomationService();
  await startLocalAutomationService();
}

export async function stopLocalAutomationService(): Promise<void> {
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
  killStaleAutomationOnPort();
}
