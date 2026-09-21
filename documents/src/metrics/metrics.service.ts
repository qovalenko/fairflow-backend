import { Injectable } from '@nestjs/common';
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export type DocumentsOperation = 'generate' | 'regenerate' | 'upload' | 'download';

@Injectable()
export class MetricsService {
  readonly registry: Registry;
  private readonly httpRequestsTotal: Counter;
  private readonly httpRequestDuration: Histogram;
  private readonly documentsOperationsTotal: Counter;
  private readonly documentsErrorsTotal: Counter;

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

    this.documentsOperationsTotal = new Counter({
      name: 'documents_operations_total',
      help: 'Documents business operations (generate/regenerate/upload/download)',
      labelNames: ['operation'],
      registers: [this.registry],
    });

    this.documentsErrorsTotal = new Counter({
      name: 'documents_errors_total',
      help: 'Documents domain errors surfaced to clients',
      labelNames: ['code'],
      registers: [this.registry],
    });
  }

  recordRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const status = String(statusCode);
    this.httpRequestsTotal.inc({ method, route, status_code: status });
    this.httpRequestDuration.observe({ method, route, status_code: status }, durationMs / 1000);
  }

  recordDocumentsOperation(operation: DocumentsOperation): void {
    this.documentsOperationsTotal.inc({ operation });
  }

  recordDocumentsError(code: string): void {
    this.documentsErrorsTotal.inc({ code: code || 'UNKNOWN' });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
