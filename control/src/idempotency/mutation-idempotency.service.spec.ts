import { MutationIdempotencyService } from './mutation-idempotency.service';
import type { ModuleStateEntry } from '../projects/module-lifecycle.service';

describe('MutationIdempotencyService', () => {
  const service = new MutationIdempotencyService();

  const sampleEntry = (): ModuleStateEntry => ({
    moduleId: 'reports',
    state: 'installed',
    enabled: false,
    installed: true,
    locked: false,
    kind: 'business',
    version: '1.0.0',
    latestVersion: '1.0.0',
    upgradeAvailable: false,
    runtimeStatus: 'active',
    everSuspended: false,
    configState: 'ready',
  });

  it('replays the first response when the same idempotency key is retried', async () => {
    let n = 0;
    const exec = jest.fn(async () => ({ ...sampleEntry(), version: `v-${++n}` }));

    const first = await service.run(
      { projectId: 'p1', key: 'idem-1', operation: 'module.install:reports' },
      exec,
    );
    const replay = await service.run(
      { projectId: 'p1', key: 'idem-1', operation: 'module.install:reports' },
      exec,
    );

    expect(first.version).toBe('v-1');
    expect(replay).toEqual(first);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('runs twice when no idempotency key is supplied', async () => {
    let n = 0;
    const exec = jest.fn(async () => ({ ...sampleEntry(), version: `v-${++n}` }));

    await service.run(
      { projectId: 'p1', key: undefined, operation: 'module.install:reports' },
      exec,
    );
    await service.run({ projectId: 'p1', key: '', operation: 'module.install:reports' }, exec);

    expect(exec).toHaveBeenCalledTimes(2);
  });
});
