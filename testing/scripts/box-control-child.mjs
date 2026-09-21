#!/usr/bin/env node
/**
 * Boots local control (gRPC + HTTP) in a plain Node child process.
 * Jest's runtime breaks Nest ClientGrpcProxy outbound metadata in-process.
 */
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

global.describe = () => {};
global.describe.skip = () => {};
global.it = () => {};

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const testingDist = join(root, "testing", "dist", "box");

const { applyBoxEnv } = require(join(testingDist, "env.js"));
const { loadDomainCreateApplication } = require(join(testingDist, "load-domain-app.js"));
const { waitForPort } = require(join(testingDist, "grpc.js"));
const { Transport } = require("@nestjs/microservices");
const { RpcAppExceptionFilter } = require(join(
  root,
  "shared",
  "dist",
  "grpc",
  "rpc-exception.filter.js",
));

const grpcPort =
  parseInt(process.env.BOX_CONTROL_GRPC_PORT ?? "0", 10) ||
  15002 + Math.floor(Math.random() * 1000);
const httpPort =
  parseInt(process.env.BOX_CONTROL_HTTP_PORT ?? "0", 10) ||
  13002 + Math.floor(Math.random() * 1000);

applyBoxEnv({ controlGrpcPort: grpcPort, controlHttpPort: httpPort });

const createApplication = loadDomainCreateApplication("control");
const app = await createApplication();
const protoPath = join(root, "proto", "fairflow", "control", "v1", "control.proto");
const microservice = app.connectMicroservice({
  transport: Transport.GRPC,
  options: {
    package: "fairflow.control.v1",
    protoPath,
    url: `127.0.0.1:${grpcPort}`,
    loader: { keepCase: true, longs: Number },
  },
});
microservice.useGlobalFilters(new RpcAppExceptionFilter());
await app.startAllMicroservices();
await app.listen(httpPort, "127.0.0.1");
await waitForPort("127.0.0.1", grpcPort, 90_000);

process.stdout.write(`${JSON.stringify({ ready: true, grpcPort, httpPort })}\n`);

const shutdown = async () => {
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("close", shutdown);
