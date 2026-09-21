import * as fs from 'node:fs';
import * as path from 'node:path';

/** TODO-035/328: dead OAuth Authorization Server code removed from auth workspace. */
describe('DEORG cleanup — auth dead code', () => {
  const authRoot = path.resolve(__dirname, '..');

  it('does not ship auth/src/oauth', () => {
    expect(fs.existsSync(path.join(authRoot, 'src/oauth'))).toBe(false);
  });

  it('does not ship auth/src/users (oauth-only REST surface)', () => {
    expect(fs.existsSync(path.join(authRoot, 'src/users'))).toBe(false);
  });
});
