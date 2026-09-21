import { Injectable } from '@nestjs/common';
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry: Registry;
  private readonly httpRequestsTotal: Counter;
  private readonly httpRequestDuration: Histogram;
  private readonly permissionProjectionLkgServeTotal: Counter;
  private readonly chatWsConnectionsGauge: Gauge;
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

    this.permissionProjectionLkgServeTotal = new Counter({
      name: 'permission_projection_lkg_serve_total',
      help: 'Times a last-known-good permission projection was served after a control transport failure',
      registers: [this.registry],
    });

    this.chatWsConnectionsGauge = new Gauge({
      name: 'chat_ws_connections',
      help: 'Current chat WebSocket connections on this gateway replica',
      registers: [this.registry],
    });
    this.chatMessagesSentTotal = new Counter({
      name: 'chat_messages_sent_total',
      help: 'Chat messages accepted by gateway send paths',
      labelNames: ['sender_type'],
      registers: [this.registry],
    });
  }

  recordRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const status = String(statusCode);
    this.httpRequestsTotal.inc({ method, route, status_code: status });
    this.httpRequestDuration.observe({ method, route, status_code: status }, durationMs / 1000);
  }

  /** LKG-serve of the permission projection (P0-3 resilience path). */
  recordPermissionProjectionLkgServe(): void {
    this.permissionProjectionLkgServeTotal.inc();
  }

  /** NFR-CHAT-090: track live WS connections (per replica). */
  setChatWsConnections(total: number): void {
    this.chatWsConnectionsGauge.set(total);
  }

  recordChatMessageSent(senderType: string): void {
    this.chatMessagesSentTotal.inc({ sender_type: senderType || 'user' });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
