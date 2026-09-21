import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRouteInventory, controllersOf, serializeInventory } from './route-inventory.util';
import { BffApiModule } from './bff-api.module';

/**
 * P28 — frozen route-inventory snapshot for the BFF (gateway) god-controller
 * split. This walks every controller in BffApiModule and serialises the full
 * HTTP contract (method, path, version, guard composition, @Public,
 * @RequireModule, @RequirePermission, @ApiTags) — WITHOUT the owning controller
 * class, so a route may move between controllers during the split while the
 * snapshot stays identical.
 *
 * Every P28 PR must keep this snapshot green. A change here means the public
 * surface shifted — that is a red flag, not a routine update, and needs an
 * explicit review + `jest -u` with justification.
 *
 * Runs on pure decorator metadata; no gRPC/bootstrap needed.
 */
describe('BFF route inventory (P28 contract freeze)', () => {
  const controllers = controllersOf(BffApiModule);
  const inventory = buildRouteInventory(controllers, 'api');
  const serialized = serializeInventory(inventory);

  it('discovers the BffApiModule controllers', () => {
    expect(controllers.length).toBeGreaterThan(0);
    // sanity: the two god-controllers are present in the module today.
    const names = controllers.map((c) => c.name);
    expect(names).toContain('CrmBffController');
    expect(names).toContain('V1DataBffController');
  });

  it('has no duplicate (method, path, version) routes', () => {
    const keys = inventory.map((e) => `${e.method} ${e.path} v${e.version}`);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it('matches the frozen route contract', () => {
    expect(serialized).toMatchSnapshot();
  });

  /**
   * SEC-ISO-1 (TODO-001): no BFF handler may derive the effective projectId from
   * the request body — the guards (ProjectAccessGuard/GatewayModuleGuard) only see
   * params/query/header, so a body-sourced projectId lets a member of project A
   * write into project B (cross-project IDOR). Handlers must resolve it via
   * `authoritativeProjectId` (or query/header only) instead. This scans the BFF
   * controller sources for the vulnerable pattern to keep the class closed.
   */
  it('no handler builds the effective projectId from the request body', () => {
    const dir = __dirname;
    const offenders: string[] = [];
    // `body.projectId` used as the PRIMARY source (body wins over query/header).
    const vulnerable =
      /(body\??\.projectId|body\[['"]projectId['"]\])\s*(\?\?|\|\|)\s*(q?pid|projectId|query)/;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.controller.ts')) continue;
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (vulnerable.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
