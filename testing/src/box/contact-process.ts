import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { localContactServiceEnv } from './conn';
import { waitForContactGrpc } from './contact-grpc-client';

let child: ChildProcess | null = null;

function backendRoot(): string {
  const fromContact = join(process.cwd(), '..');
  if (fromContact.endsWith('contact/..') || process.cwd().endsWith('/contact')) {
    return join(process.cwd(), '..');
  }
  return fromContact;
}

/** Spawn local contact service (prod build) wired to the box stand peers/stores. */
export async function startLocalContactService(): Promise<void> {
  if (child) return;
  const root = backendRoot();
  const contactDir = join(root, 'contact');
  const proc = spawn('node', ['dist/main.js'], {
    cwd: contactDir,
    env: localContactServiceEnv(),
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
      console.error(`local contact exited with code ${code}`);
    }
    child = null;
  });
  await waitForContactGrpc();
}

export async function stopLocalContactService(): Promise<void> {
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
