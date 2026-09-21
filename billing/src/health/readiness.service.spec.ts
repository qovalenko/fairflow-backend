import { ReadinessService } from './readiness.service';

describe('ReadinessService', () => {
  it('tracks readiness flag for ops probes', () => {
    const svc = new ReadinessService();
    expect(svc.isReady()).toBe(true);
    svc.setReady(false);
    expect(svc.isReady()).toBe(false);
    svc.setReady(true);
    expect(svc.isReady()).toBe(true);
  });
});
