import { HttpException } from '@nestjs/common';

describe('legacy /api/forgot-password stubs (§6.1)', () => {
  it('returns 410 Gone instead of a fake success envelope', () => {
    const err = new HttpException(
      { ok: false, code: 'GONE', message: 'Use POST /v1/auth/forgot-password' },
      410,
    );
    expect(err.getStatus()).toBe(410);
    expect(err.getResponse()).toMatchObject({ ok: false, code: 'GONE' });
  });
});
