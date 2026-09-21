/**
 * Child-process bootstrap for local gateway (box integration).
 * stdin: none; env must include GW_PORT and box integration vars from parent.
 */
const { join } = require('node:path');

async function main() {
  const port = parseInt(process.env.GW_PORT ?? '0', 10);
  if (!port) throw new Error('GW_PORT is required');

  const { applyGatewayBoxEnv } = require('@fairflow/testing/dist/box/env');
  applyGatewayBoxEnv({ gatewayHttpPort: port });

  const root = join(__dirname, '..', '..');
  const fs = require('node:fs');
  const candidates = [
    join(root, 'gateway', 'dist', 'application.js'),
    join(root, 'gateway', 'src', 'application.js'),
  ];
  const appFile = candidates.find((p) => fs.existsSync(p));
  if (!appFile) {
    throw new Error(
      'gateway application.js not found — run `cd gateway && npx tsc -p tsconfig.json --skipLibCheck`',
    );
  }
  const appModulePath = appFile.replace(/\.js$/, '');
  const { createApplication } = require(appModulePath);
  const app = await createApplication();
  await app.listen(port, '127.0.0.1');

  if (process.send) {
    process.send({ type: 'ready', port });
  }

  process.on('message', (msg) => {
    if (msg && msg.type === 'stop') {
      void app.close().then(() => process.exit(0));
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
