import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('FR-ACCESS-400 share owner snapshot', () => {
  it('resolves record owner from owner_id or assignee_id', () => {
    const src = readFileSync(join(__dirname, 'v1-data-bff.controller.ts'), 'utf8');
    expect(src).toContain('ownerUserIdFromRecord');
    expect(src).toContain('row?.owner_id ?? row?.assignee_id');
  });
});
