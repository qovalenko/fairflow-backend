import { Injectable } from '@nestjs/common';
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry: Registry;
  private readonly httpRequestsTotal: Counter;
  private readonly httpRequestDuration: Histogram;
  private readonly chatMessagesSentTotal: Counter;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.chatMessagesSentTotal = new Counter({
      name: 'chat_messages_sent_total',
      help: 'Chat messages persisted by the chat domain',
      labelNames: ['sender_type'],
      registers: [this.registry],
    });
  }

  recordChatMessageSent(senderType: string): void {
    this.chatMessagesSentTotal.inc({ sender_type: senderType || 'user' });
  }

  recordRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const status = String(statusCode);
    this.httpRequestsTotal.inc({ method, route, status_code: status });
    this.httpRequestDuration.observe({ method, route, status_code: status }, durationMs / 1000);
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
