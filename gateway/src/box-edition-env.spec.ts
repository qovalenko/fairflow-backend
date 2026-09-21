import * as fs from 'node:fs';
import * as path from 'node:path';

/** NFR-560 — BOX deploy must pin GATEWAY_PROJECT_ACCESS_ENFORCE=true outside dev-only .env.example. */
describe('NFR-560 BOX gateway deploy env', () => {
  const gatewayRoot = path.resolve(__dirname, '..');

  it('documents GATEWAY_PROJECT_ACCESS_ENFORCE=true in box-edition.env.example', () => {
    const boxEnv = fs.readFileSync(path.join(gatewayRoot, 'box-edition.env.example'), 'utf8');
    expect(boxEnv).toMatch(/^\s*GATEWAY_PROJECT_ACCESS_ENFORCE=true\s*$/m);
  });

  it('keeps the dev .env.example aligned', () => {
    const devEnv = fs.readFileSync(path.join(gatewayRoot, '.env.example'), 'utf8');
    expect(devEnv).toMatch(/^\s*GATEWAY_PROJECT_ACCESS_ENFORCE=true\s*$/m);
  });
});
