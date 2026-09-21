import { ProjectProvisioningService } from './project-provisioning.service';

describe('ProjectProvisioningService retry (FR-PSET-530)', () => {
  const build = () => {
    const service = new ProjectProvisioningService(
      { getService: () => ({}) } as never,
      { getService: () => ({}) } as never,
      { getService: () => ({}) } as never,
    );
    return service as unknown as {
      call: (domain: string, fn: () => Promise<unknown>) => Promise<boolean>;
    };
  };

  it('retries transient failures and succeeds on the last attempt', async () => {
    const svc = build();
    let attempts = 0;
    const ok = await svc.call('pipe', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('returns false after exhausting retries', async () => {
    const svc = build();
    let attempts = 0;
    const ok = await svc.call('orders', async () => {
      attempts += 1;
      throw new Error('hard fail');
    });
    expect(ok).toBe(false);
    expect(attempts).toBe(3);
  });
});
