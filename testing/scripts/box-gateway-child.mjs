#!/usr/bin/env node
/** Boots local gateway HTTP in a plain Node child (see box-control-child.mjs). */
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

global.describe = () => {};
global.describe.skip = () => {};
global.it = () => {};

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const testingDist = join(root, "testing", "dist", "box");

const { applyGatewayBoxEnv } = require(join(testingDist, "env.js"));
const { loadDomainCreateApplication } = require(join(testingDist, "load-domain-app.js"));
const { waitForHttpOk } = require(join(testingDist, "http.js"));

const httpPort =
  parseInt(process.env.BOX_GATEWAY_HTTP_PORT ?? "0", 10) ||
  13000 + Math.floor(Math.random() * 1000);

applyGatewayBoxEnv({ gatewayHttpPort: httpPort });

const createApplication = loadDomainCreateApplication("gateway");
const app = await createApplication();
await app.listen(httpPort, "127.0.0.1");
await waitForHttpOk(`http://127.0.0.1:${httpPort}/healthz`, 120_000);

process.stdout.write(`${JSON.stringify({ ready: true, httpPort })}\n`);

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
