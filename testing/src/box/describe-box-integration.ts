import { hasBoxIntegrationEnv } from './conn';

/**
 * the box stand integration closure harness — runs ONLY when `BOX_INTEGRATION=1`.
 * Requires network reachability to the box stand and a locally started primary domain.
 *
 * Env is checked when Jest executes the outer `describe` callback (after module
 * init), not at hoist time — otherwise gateway specs can self-skip despite
 * `BOX_INTEGRATION=1` being set in the shell.
 */
export const describeBoxIntegration: jest.Describe = ((name, fn) =>
  describe(name, () => {
    if (!hasBoxIntegrationEnv()) {
      it.skip('requires BOX_INTEGRATION=1 (the box stand integration closure)', () => {});
      return;
    }
    fn();
  })) as jest.Describe;
