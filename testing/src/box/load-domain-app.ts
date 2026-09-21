import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";

export type DomainApplicationFactory = () => Promise<INestApplication>;

/**
 * Load domain bootstrap via extensionless require under `src/application`.
 *
 * Requires `npm run sync:box-harness-js` (copies dist/*.js → src/*.js) before box
 * integration tests. Avoids ts-jest intercepting `.ts` (breaks outbound gRPC
 * metadata in Jest) and avoids stale hand-edited colocated JS from random tsc runs.
 */
export function loadDomainCreateApplication(
  domain: "control" | "gateway",
): DomainApplicationFactory {
  const entry = join(__dirname, "..", "..", "..", domain, "src", "application");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(entry) as { createApplication: DomainApplicationFactory };
  return mod.createApplication;
}
