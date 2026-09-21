import { GatewayTimeoutException } from '@nestjs/common';
import { of, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { grpcBffCall } from './grpc-bff-call';

/**
 * BFF per-call deadline semantics (P2.f). A gateway→upstream timeout is a 504
 * Gateway Timeout (mirrors the gRPC DEADLINE_EXCEEDED→504 mapping), NOT a 503.
 */
describe('grpcBffCall', () => {
  it('passes through a value that resolves before the deadline', async () => {
    const result = await grpcBffCall(of({ ok: true }), 50);
    expect(result).toEqual({ ok: true });
  });

  it('raises 504 GatewayTimeoutException when the upstream exceeds the deadline', async () => {
    // Emits after 100ms; deadline is 10ms → must time out.
    const slow = timer(100).pipe(map(() => ({ ok: true })));
    await expect(grpcBffCall(slow, 10)).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('reports HTTP 504 on the timeout exception', async () => {
    const slow = timer(100).pipe(map(() => ({ ok: true })));
    await expect(grpcBffCall(slow, 10)).rejects.toMatchObject({ status: 504 });
  });
});
