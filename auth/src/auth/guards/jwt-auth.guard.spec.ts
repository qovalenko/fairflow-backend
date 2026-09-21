import { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  it('extracts the HTTP request from the execution context', () => {
    const req = { headers: { authorization: 'Bearer tok' } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const guard = new JwtAuthGuard();
    expect(guard.getRequest(ctx)).toBe(req);
  });
});
