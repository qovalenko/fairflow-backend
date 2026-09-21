import { status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { DocumentsMetricsExceptionFilter } from './documents-metrics.exception-filter';
import { MetricsService } from './metrics.service';

describe('DocumentsMetricsExceptionFilter (NFR-DOCS-080)', () => {
  it('records documents_errors_total for structured domain codes', async () => {
    const metrics = new MetricsService();
    const filter = new DocumentsMetricsExceptionFilter(metrics);
    const recordSpy = jest.spyOn(metrics, 'recordDocumentsError');

    const obs = filter.catch(
      new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'unsafe template',
        details: { code: 'TEMPLATE_INVALID', reason: 'vba' },
      }),
      {} as never,
    );

    await expect(lastValueFrom(obs)).rejects.toBeDefined();
    expect(recordSpy).toHaveBeenCalledWith('TEMPLATE_INVALID');
  });

  it('does not record server-side gRPC failures', async () => {
    const metrics = new MetricsService();
    const filter = new DocumentsMetricsExceptionFilter(metrics);
    const recordSpy = jest.spyOn(metrics, 'recordDocumentsError');

    const obs = filter.catch(
      new RpcException({
        code: GrpcStatus.INTERNAL,
        message: 'boom',
      }),
      {} as never,
    );

    await expect(lastValueFrom(obs)).rejects.toBeDefined();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('records ALL_CAPS domain codes carried only in the RpcException message', async () => {
    const metrics = new MetricsService();
    const filter = new DocumentsMetricsExceptionFilter(metrics);
    const recordSpy = jest.spyOn(metrics, 'recordDocumentsError');

    const obs = filter.catch(
      new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'TEMPLATE_NOT_PUBLISHED',
      }),
      {} as never,
    );

    await expect(lastValueFrom(obs)).rejects.toBeDefined();
    expect(recordSpy).toHaveBeenCalledWith('TEMPLATE_NOT_PUBLISHED');
  });
});
