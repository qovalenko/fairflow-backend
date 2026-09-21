import { join } from "node:path";
import { Transport } from "@nestjs/microservices";
import type { INestApplication } from "@nestjs/common";
import { applyBoxEnv, type ApplyBoxEnvOptions } from "./env";
import {
  createControlGrpcClient,
  waitForPort,
  type ControlGrpcClients,
} from "./grpc";
import { loadDomainCreateApplication } from "./load-domain-app";
import { spawnBoxHarnessChild, stopBoxHarnessChild } from "./spawn-harness-child";

export interface LocalControlHarness {
  grpcPort: number;
  httpPort: number;
  grpc: ControlGrpcClients;
  stop: () => Promise<void>;
}

async function bootControlInProcess(
  grpcPort: number,
  httpPort: number,
): Promise<{ app: INestApplication; grpc: ControlGrpcClients }> {
  applyBoxEnv({ controlGrpcPort: grpcPort, controlHttpPort: httpPort });
  const createApplication = loadDomainCreateApplication("control");
  const app = await createApplication();
  const protoPath = join(
    __dirname,
    "..",
    "..",
    "..",
    "proto",
    "fairflow",
    "control",
    "v1",
    "control.proto",
  );
  app.connectMicroservice({
    transport: Transport.GRPC,
    options: {
      package: "fairflow.control.v1",
      protoPath,
      url: `127.0.0.1:${grpcPort}`,
      loader: { keepCase: true, longs: Number },
    },
  });
  await app.startAllMicroservices();
  await app.listen(httpPort, "127.0.0.1");
  await waitForPort("127.0.0.1", grpcPort, 90_000);
  const grpc = createControlGrpcClient(`127.0.0.1:${grpcPort}`);
  return { app, grpc };
}

/**
 * Bootstraps the real control Nest app locally (gRPC + HTTP) with the box stand peer URLs.
 * Under Jest the app runs in a child Node process so ClientGrpcProxy outbound metadata
 * stays intact (Jest breaks it in-process).
 */
export async function startLocalControlApp(
  opts: ApplyBoxEnvOptions = {},
): Promise<LocalControlHarness> {
  const grpcPort =
    opts.controlGrpcPort ?? 15002 + Math.floor(Math.random() * 1000);
  const httpPort =
    opts.controlHttpPort ?? 13002 + Math.floor(Math.random() * 1000);

  if (process.env.JEST_WORKER_ID !== undefined) {
    const { child, ready } = await spawnBoxHarnessChild("box-control-child.mjs", {
      BOX_CONTROL_GRPC_PORT: String(grpcPort),
      BOX_CONTROL_HTTP_PORT: String(httpPort),
    });
    const boundGrpcPort = ready.grpcPort ?? grpcPort;
    const boundHttpPort = ready.httpPort ?? httpPort;
    const grpc = createControlGrpcClient(`127.0.0.1:${boundGrpcPort}`);
    return {
      grpcPort: boundGrpcPort,
      httpPort: boundHttpPort,
      grpc,
      stop: async () => {
        await stopBoxHarnessChild(child);
      },
    };
  }

  const { app, grpc } = await bootControlInProcess(grpcPort, httpPort);
  return {
    grpcPort,
    httpPort,
    grpc,
    stop: async () => {
      await app.close();
    },
  };
}
