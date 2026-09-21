import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { FastifyRequest, FastifyReply } from 'fastify';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const method = req.method;
    const route = req.routeOptions?.url ?? req.url ?? 'unknown';
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const statusCode = reply.statusCode ?? 200;
          this.metrics.recordRequest(method, route, statusCode, Date.now() - start);
        },
        error: () => {
          const statusCode = reply.statusCode ?? 500;
          this.metrics.recordRequest(method, route, statusCode, Date.now() - start);
        },
      }),
    );
  }
}
