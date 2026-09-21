import { status as GrpcStatus } from '@grpc/grpc-js';
import { grpcStatusToHttp } from './grpc-to-http';

describe('grpcStatusToHttp — FR-PRODUCTS-150', () => {
  it('maps ABORTED (PRODUCT_ORDER_TYPE_DANGLING gRPC code) to HTTP 409', () => {
    expect(grpcStatusToHttp(GrpcStatus.ABORTED)).toBe(409);
  });

  it('does not map FAILED_PRECONDITION to 409 (that path is 422)', () => {
    expect(grpcStatusToHttp(GrpcStatus.FAILED_PRECONDITION)).toBe(422);
  });
});
