import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * NFR-550 — CI barrier: Mongo index specs in CRM domains must lead compound
 * business indexes with `projectId` as the first key (tenant isolation).
 */
describe('NFR-550 Mongo projectId-first index barrier', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const CRM_MONGO_DOMAINS = [
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

  function collectIndexKeyLiterals(domain: string): string[] {
    const srcRoot = path.join(repoRoot, domain, 'src');
    if (!fs.existsSync(srcRoot)) return [];
    const keys: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          /index.*\.ts$/.test(entry.name) ||
          entry.name === 'mongo.service.ts' ||
          /\.store\.ts$/.test(entry.name)
        ) {
          keys.push(...extractProjectIdIndexKeys(fs.readFileSync(full, 'utf8')));
        }
      }
    };
    walk(srcRoot);
    return keys;
  }

  function extractProjectIdIndexKeys(src: string): string[] {
    const found: string[] = [];
    const patterns = [
      /key:\s*\{([^}]*projectId[^}]*)\}/g,
      /createIndex\s*\(\s*\{([^}]*projectId[^}]*)\}/g,
      /createIndex\s*\(\s*\{([^}]*project_id[^}]*)\}/g,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        found.push(m[1].replace(/\s+/g, ' ').trim());
      }
    }
    return found;
  }

  function isProjectFirstKey(key: string): boolean {
    return /^projectId:\s*1\b/.test(key) || /^project_id:\s*1\b/.test(key);
  }

  it('every CRM mongo domain declares projectId-first compound indexes', () => {
    const offenders: string[] = [];
    for (const domain of CRM_MONGO_DOMAINS) {
      const keys = collectIndexKeyLiterals(domain);
      if (keys.length === 0) {
        offenders.push(`${domain}: no projectId index keys found`);
        continue;
      }
      for (const key of keys) {
        if (!isProjectFirstKey(key)) {
          offenders.push(`${domain}: project scope key is not first in { ${key} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
