import type { INestApplication } from '@nestjs/common';
import {
  applyGatewayBoxEnv,
  hasBoxIntegration,
  probeAndApplyBoxS3Env,
  type ApplyGatewayBoxEnvOptions,
} from './env';
import { waitForHttpOk } from './http';
import { loadDomainCreateApplication } from './load-domain-app';
import { spawnBoxHarnessChild, stopBoxHarnessChild } from './spawn-harness-child';

export interface LocalGatewayHarness {
  httpPort: number;
  apiBase: string;
  stop: () => Promise<void>;
}

async function bootGatewayInProcess(
  httpPort: number,
): Promise<{ app: INestApplication }> {
  applyGatewayBoxEnv({ gatewayHttpPort: httpPort });
  const createApplication = loadDomainCreateApplication('gateway');
  const app = await createApplication();
  await app.listen(httpPort, '127.0.0.1');
  await waitForHttpOk(`http://127.0.0.1:${httpPort}/healthz`, 120_000);
  return { app };
}

/**
 * Bootstraps the real gateway Nest app locally (HTTP) with the box stand peer gRPC URLs.
 * Under Jest the app runs in a child Node process (see control-app.ts).
 */
export async function startLocalGatewayApp(
  opts: ApplyGatewayBoxEnvOptions = {},
): Promise<LocalGatewayHarness> {
  const httpPort = opts.gatewayHttpPort ?? 13000 + Math.floor(Math.random() * 1000);

  if (hasBoxIntegration() && process.env.BOX_S3_INTEGRATION !== '1') {
    await probeAndApplyBoxS3Env();
  }

  if (process.env.JEST_WORKER_ID !== undefined) {
    const { child, ready } = await spawnBoxHarnessChild('box-gateway-child.mjs', {
      BOX_GATEWAY_HTTP_PORT: String(httpPort),
    });
    const boundHttpPort = ready.httpPort ?? httpPort;
    return {
      httpPort: boundHttpPort,
      apiBase: `http://127.0.0.1:${boundHttpPort}/api`,
      stop: async () => {
        await stopBoxHarnessChild(child);
      },
    };
  }

  const { app } = await bootGatewayInProcess(httpPort);
  return {
    httpPort,
    apiBase: `http://127.0.0.1:${httpPort}/api`,
    stop: async () => {
      await app.close();
    },
  };
}
