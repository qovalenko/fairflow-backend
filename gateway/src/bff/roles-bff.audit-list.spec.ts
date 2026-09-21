import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('FR-ACCESS-610 roles audit REST', () => {
  it('exposes filtered GET projects/:projectId/audit/roles handler', () => {
    const src = readFileSync(join(__dirname, 'roles-bff.controller.ts'), 'utf8');
    expect(src).toContain("@Get('projects/:projectId/audit/roles')");
    expect(src).toContain('filter_actor_user_id');
    expect(src).toContain('cursor');
  });
});
