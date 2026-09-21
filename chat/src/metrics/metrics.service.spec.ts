import { MetricsService } from './metrics.service';

describe('MetricsService chat', () => {
  it('инкрементирует chat_messages_sent_total по sender_type', async () => {
    const svc = new MetricsService();
    svc.recordChatMessageSent('integration');
    svc.recordChatMessageSent('');
    const text = await svc.getMetrics();
    expect(text).toContain('chat_messages_sent_total');
    expect(text).toContain('sender_type="integration"');
    expect(text).toContain('sender_type="user"');
  });

  it('записывает http_requests_total и гистограмму длительности', async () => {
    const svc = new MetricsService();
    svc.recordRequest('GET', '/readyz', 200, 25);
    svc.recordRequest('GET', '/readyz', 503, 120);
    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('method="GET"');
    expect(text).toContain('route="/readyz"');
    expect(text).toContain('status_code="503"');
    expect(text).toContain('http_request_duration_seconds');
  });

  it('getMetrics возвращает default process metrics', async () => {
    const svc = new MetricsService();
    const text = await svc.getMetrics();
    expect(text).toContain('process_cpu');
  });
});
