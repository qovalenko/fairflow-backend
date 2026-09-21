import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let svc: MetricsService;

  beforeEach(() => {
    svc = new MetricsService();
  });

  it('records HTTP request counters and histograms', async () => {
    svc.recordRequest('GET', '/api/v1/deals', 200, 125);
    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('http_request_duration_seconds');
  });

  it('records permission projection LKG serve counter', async () => {
    svc.recordPermissionProjectionLkgServe();
    const text = await svc.getMetrics();
    expect(text).toContain('permission_projection_lkg_serve_total');
  });

  it('tracks chat websocket gauge and message counter', async () => {
    svc.setChatWsConnections(3);
    svc.recordChatMessageSent('user');
    svc.recordChatMessageSent('');
    const text = await svc.getMetrics();
    expect(text).toContain('chat_ws_connections');
    expect(text).toContain('chat_messages_sent_total');
  });
});
