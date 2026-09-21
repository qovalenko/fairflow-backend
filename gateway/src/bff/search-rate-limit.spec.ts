import { HttpException } from '@nestjs/common';
import { SearchQueryRateLimiter, searchQueryRateLimitKeys } from './search-rate-limit';

describe('searchQueryRateLimitKeys', () => {
  it('builds ip and user+project keys', () => {
    expect(searchQueryRateLimitKeys('u1', '1.2.3.4', 'p1')).toEqual([
      'search:ip:1.2.3.4',
      'search:user:u1:p1',
    ]);
    expect(searchQueryRateLimitKeys('u1', '', 'p1')).toEqual(['search:user:u1:p1']);
  });
});

describe('SearchQueryRateLimiter', () => {
  it('allows requests within the window budget', () => {
    const limiter = new SearchQueryRateLimiter();
    for (let i = 0; i < 3; i += 1) {
      limiter.assertAllowed('k', 3, 60_000);
    }
    expect(() => limiter.assertAllowed('k', 3, 60_000)).toThrow(HttpException);
  });

  it('resets the counter after the window elapses', () => {
    const limiter = new SearchQueryRateLimiter();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    limiter.assertAllowed('k', 1, 1000);
    expect(() => limiter.assertAllowed('k', 1, 1000)).toThrow(HttpException);
    jest.spyOn(Date, 'now').mockReturnValue(now + 1001);
    expect(() => limiter.assertAllowed('k', 1, 1000)).not.toThrow();
    jest.restoreAllMocks();
  });
});
