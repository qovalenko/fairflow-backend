import { buildOpsStatus, OpsStatusBody } from './ops-http-contract';

describe('buildOpsStatus', () => {
  it('returns the full /status shape', () => {
    const body = buildOpsStatus();
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
    expect(typeof body.service).toBe('string');
    expect(typeof body.version).toBe('string');
    expect(typeof body.commit).toBe('string');
    expect(typeof body.bootTime).toBe('string');
    expect(() => new Date(body.bootTime).toISOString()).not.toThrow();
    expect(typeof body.uptimeSec).toBe('number');
    expect(Number.isInteger(body.uptimeSec)).toBe(true);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);

    // exact key set — no extra/missing fields
    expect(Object.keys(body).sort()).toEqual(
      ['bootTime', 'commit', 'service', 'status', 'timestamp', 'uptimeSec', 'version'].sort(),
    );
  });

  it('honours explicit overrides and pkg', () => {
    const body: OpsStatusBody = buildOpsStatus({
      pkg: { name: 'svc-x', version: '9.9.9' },
    });
    expect(body.service).toBe('svc-x');
    expect(body.version).toBe('9.9.9');

    const overridden = buildOpsStatus({ service: 'forced', version: '1.2.3' });
    expect(overridden.service).toBe('forced');
    expect(overridden.version).toBe('1.2.3');
  });

  it('resolves commit from env with fallback', () => {
    const prev = process.env.GIT_COMMIT;
    process.env.GIT_COMMIT = 'abc1234';
    try {
      expect(buildOpsStatus().commit).toBe('abc1234');
    } finally {
      if (prev === undefined) {
        delete process.env.GIT_COMMIT;
      } else {
        process.env.GIT_COMMIT = prev;
      }
    }
  });
});
