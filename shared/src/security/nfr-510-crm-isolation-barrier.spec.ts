import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * NFR-510 — CI barrier: every CRM Mongo domain must carry at least one test that
 * proves projectId isolation (no cross-project reads/writes/purge leaks).
 */
describe('NFR-510 CRM project-isolation test barrier', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const CRM_DOMAINS = [
    'contact',
    'company',
    'pipe',
    'orders',
    'product',
    'activity',
    'documents',
    'chat',
    'automation',
    'search',
    'reports',
  ] as const;

  const ISOLATION_MARKERS = [
    /NFR-510/i,
    /projectId isolation/i,
    /project isolation/i,
    /cross-project/i,
    /Different-project/i,
    /foreign project/i,
    /project-purge\.consumer\.spec/,
    /filtered by \{ projectId \}/,
    /scoped by \{.*projectId/i,
  ];

  function collectSpecFiles(domain: string): string[] {
    const root = path.join(repoRoot, domain, 'src');
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.spec.ts')) out.push(full);
      }
    };
    walk(root);
    return out;
  }

  it('each CRM domain has at least one project-isolation regression test', () => {
    const missing: string[] = [];
    for (const domain of CRM_DOMAINS) {
      const specs = collectSpecFiles(domain);
      const covered = specs.some((file) => {
        const src = fs.readFileSync(file, 'utf8');
        return ISOLATION_MARKERS.some((re) => re.test(src));
      });
      if (!covered) missing.push(domain);
    }
    expect(missing).toEqual([]);
  });
});
