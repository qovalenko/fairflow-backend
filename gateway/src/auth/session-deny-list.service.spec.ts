import { SessionDenyListService } from './session-deny-list.service';
import { SESSION_DENY_PEP_CACHE_MS, sessionDenyRedisKey } from '@fairflow/shared';
import { of } from 'rxjs';

/**
 * Unit tests for the deny-list PEP toggle semantics (OQ-AUTH-7).
 * ON by default; opt-out only via an explicit falsy value.
 */
describe('SessionDenyListService.enabled', () => {
  const OLD_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  function make(): SessionDenyListService {
    return new SessionDenyListService();
  }

  it('is ON by default when the env var is unset', () => {
    delete process.env.AUTH_SESSION_DENYLIST;
    expect(make().enabled).toBe(true);
  });

  it('stays ON for the explicit "true" value', () => {
    process.env.AUTH_SESSION_DENYLIST = 'true';
    expect(make().enabled).toBe(true);
  });

  it('stays ON for any non-falsy value', () => {
    process.env.AUTH_SESSION_DENYLIST = 'yes';
    expect(make().enabled).toBe(true);
  });

  it.each(['false', '0', 'off', 'FALSE', ' Off '])('opts out for %p', (val) => {
    process.env.AUTH_SESSION_DENYLIST = val;
    expect(make().enabled).toBe(false);
  });

  it('short-circuits to allowed when the PEP is opted out', async () => {
    process.env.AUTH_SESSION_DENYLIST = 'false';
    await expect(make().isAllowed('u1', 's1', {})).resolves.toBe(true);
  });
});

describe('SessionDenyListService.isAllowed (NFR-AUTH-020)', () => {
  const grpc = {
    validateSession: jest.fn(),
  };
  const outboundMeta = {
    build: jest.fn(() => ({})),
  };
  const redis = {
    redisEnabled: true,
    get: jest.fn(),
  };

  function make(): SessionDenyListService {
    const svc = new SessionDenyListService(
      { getService: () => grpc } as never,
      outboundMeta as never,
      redis as never,
    );
    svc.onModuleInit();
    return svc;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AUTH_SESSION_DENYLIST = 'true';
    grpc.validateSession.mockReturnValue(of({ valid: true }));
    redis.get.mockResolvedValue(null);
  });

  it('rejects immediately when Redis deny key is set (FR-AUTH-160)', async () => {
    redis.get.mockImplementation(async (key: string) =>
      key === sessionDenyRedisKey('s1') ? 'password_changed' : null,
    );
    await expect(make().checkAllowed('u1', 's1', {})).resolves.toEqual({
      allowed: false,
      reason: 'password_changed',
    });
    expect(grpc.validateSession).not.toHaveBeenCalled();
  });

  it('fail-closed when auth ValidateSession is unreachable (FR-AUTH-130)', async () => {
    grpc.validateSession.mockImplementation(() => {
      throw new Error('auth down');
    });
    await expect(make().checkAllowed('u1', 's1', {})).resolves.toEqual({
      allowed: false,
      reason: 'session_revoked',
    });
  });

  it('caches a positive ValidateSession answer and skips gRPC on repeat', async () => {
    const svc = make();
    await expect(svc.isAllowed('u1', 's1', {})).resolves.toBe(true);
    await expect(svc.isAllowed('u1', 's1', {})).resolves.toBe(true);
    expect(grpc.validateSession).toHaveBeenCalledTimes(1);
    expect(SESSION_DENY_PEP_CACHE_MS).toBeGreaterThan(0);
  });

  it('rejects a Redis deny even after a cached positive (FR-AUTH-160)', async () => {
    const svc = make();
    await expect(svc.isAllowed('u1', 's1', {})).resolves.toBe(true);
    redis.get.mockResolvedValue('1');
    await expect(svc.isAllowed('u1', 's1', {})).resolves.toBe(false);
    expect(grpc.validateSession).toHaveBeenCalledTimes(1);
  });
});
