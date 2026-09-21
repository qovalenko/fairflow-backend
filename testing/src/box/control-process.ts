import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { localControlServiceEnv } from './conn';
import { waitForControlGrpc } from './control-grpc-client';

let child: ChildProcess | null = null;

function backendRoot(): string {
  if (process.cwd().endsWith('/control')) {
    return join(process.cwd(), '..');
  }
  return join(process.cwd(), '..');
}

/** Spawn local control service (prod build) wired to the box stand peers/stores. */
export async function startLocalControlService(): Promise<void> {
  if (child) return;
  const root = backendRoot();
  const controlDir = join(root, 'control');
  const proc = spawn('node', ['dist/main.js'], {
    cwd: controlDir,
    env: localControlServiceEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  proc.stdout?.on('data', (buf) => {
    if (process.env.BOX_INTEGRATION_VERBOSE === '1') process.stdout.write(buf);
  });
  proc.stderr?.on('data', (buf) => {
    if (process.env.BOX_INTEGRATION_VERBOSE === '1') process.stderr.write(buf);
  });
  proc.on('exit', (code) => {
    if (code && code !== 0 && process.env.BOX_INTEGRATION_VERBOSE === '1') {
      console.error(`local control exited with code ${code}`);
    }
    child = null;
  });
  await waitForControlGrpc();
}

export async function stopLocalControlService(): Promise<void> {
  if (!child) return;
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
