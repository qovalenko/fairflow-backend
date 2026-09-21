import { appendPiiEgressAudit } from './pii-egress-audit';

jest.mock('./grpc-bff-call', () => ({
  grpcBffCall: jest.fn((obs: unknown) => {
    if (obs && typeof (obs as { pipe?: unknown }).pipe === 'function') {
      return Promise.resolve({});
    }
    return Promise.reject(new Error('down'));
  }),
}));

import { grpcBffCall } from './grpc-bff-call';

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('appendPiiEgressAudit (FR-COMPANIES-240)', () => {
  it('appends pii.egressed with minimal payload', async () => {
    const appendEvent = jest.fn().mockReturnValue({ pipe: jest.fn() });
    const outboundMeta = {
      build: jest.fn().mockReturnValue({}),
    };
    await appendPiiEgressAudit(
      { appendEvent },
      outboundMeta as never,
      { user: { userId: 'u-1' } },
      'p-1',
      { channel: 'export', subject: 'companies', format: 'csv', rowCount: 3 },
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'p-1',
        event_name: 'pii.egressed',
        entity_type: 'companies',
      }),
      expect.anything(),
    );
    const payload = JSON.parse(String(appendEvent.mock.calls[0][0].payload_json));
    expect(payload.channel).toBe('export');
    expect(payload.rowCount).toBe(3);
    expect(payload).not.toHaveProperty('email');
  });

  it('fail-soft when audit is unavailable', async () => {
    mockedGrpcBffCall.mockRejectedValueOnce(new Error('down'));
    await expect(
      appendPiiEgressAudit(
        { appendEvent: jest.fn().mockReturnValue({ pipe: jest.fn() }) },
        { build: jest.fn().mockReturnValue({}) } as never,
        {},
        'p-1',
        { channel: 'presigned_url', subject: 'documents', entityId: 'v-1' },
      ),
    ).resolves.toBeUndefined();
  });
});
