import { Metadata } from '@grpc/grpc-js';
import { buildDownstreamMetadata, GW_META } from './downstream-metadata';

function metaValue(md: Metadata, key: string): string | undefined {
  const value = md.get(key)?.[0];
  return typeof value === 'string' ? value : undefined;
}

describe('buildDownstreamMetadata', () => {
  it('propagates request id, user id, project id and trace headers', () => {
    const md = buildDownstreamMetadata(
      {
        headers: {
          'x-request-id': 'rid-1',
          'idempotency-key': 'idem-1',
          traceparent: '00-abc-def-01',
        },
        user: { userId: 'u-1' },
      },
      { projectId: 'p-1' },
    );

    expect(md.get(GW_META.REQUEST_ID)?.[0]).toBe('rid-1');
    expect(md.get(GW_META.USER_ID)?.[0]).toBe('u-1');
    expect(md.get(GW_META.PROJECT_ID)?.[0]).toBe('p-1');
    expect(md.get(GW_META.IDEMPOTENCY_KEY)?.[0]).toBe('idem-1');
    expect(md.get(GW_META.TRACEPARENT)?.[0]).toBe('00-abc-def-01');
    expect(md.get(GW_META.GATEWAY_ISSUED_AT)?.[0]).toMatch(/^\d+$/);
  });

  it('reads the first value when a header is an array', () => {
    const md = buildDownstreamMetadata({
      headers: { 'x-request-id': ['rid-a', 'rid-b'] },
    });

    expect(md.get(GW_META.REQUEST_ID)?.[0]).toBe('rid-a');
  });

  it('omits optional fields when absent', () => {
    const md = buildDownstreamMetadata({ headers: {} });

    expect(metaValue(md, GW_META.REQUEST_ID)).toBeUndefined();
    expect(metaValue(md, GW_META.USER_ID)).toBeUndefined();
    expect(metaValue(md, GW_META.PROJECT_ID)).toBeUndefined();
    expect(metaValue(md, GW_META.IDEMPOTENCY_KEY)).toBeUndefined();
    expect(metaValue(md, GW_META.TRACEPARENT)).toBeUndefined();
    expect(md.get(GW_META.GATEWAY_ISSUED_AT)?.[0]).toBeTruthy();
  });

  it('always stamps gateway issue time even without user context', () => {
    const before = Date.now();
    const md = buildDownstreamMetadata({ headers: {} });
    const issuedAt = Number(md.get(GW_META.GATEWAY_ISSUED_AT)?.[0]);
    expect(issuedAt).toBeGreaterThanOrEqual(before);
    expect(issuedAt).toBeLessThanOrEqual(Date.now());
    expect(md).toBeInstanceOf(Metadata);
  });
});
