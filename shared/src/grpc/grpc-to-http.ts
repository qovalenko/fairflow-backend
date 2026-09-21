import { status as GrpcStatus } from '@grpc/grpc-js';

/** Map gRPC status code to HTTP status (gateway REST). */
export function grpcStatusToHttp(code: number): number {
  switch (code) {
    case GrpcStatus.OK:
      return 200;
    case GrpcStatus.CANCELLED:
      return 499;
    case GrpcStatus.INVALID_ARGUMENT:
      return 400;
    case GrpcStatus.DEADLINE_EXCEEDED:
      return 504;
    case GrpcStatus.NOT_FOUND:
      return 404;
    case GrpcStatus.ALREADY_EXISTS:
      return 409;
    case GrpcStatus.PERMISSION_DENIED:
      return 403;
    case GrpcStatus.RESOURCE_EXHAUSTED:
      return 429;
    case GrpcStatus.FAILED_PRECONDITION:
      return 422;
    case GrpcStatus.ABORTED:
      return 409;
    case GrpcStatus.OUT_OF_RANGE:
      return 400;
    case GrpcStatus.UNIMPLEMENTED:
      return 501;
    case GrpcStatus.UNAVAILABLE:
      return 503;
    case GrpcStatus.UNAUTHENTICATED:
      return 401;
    default:
      return 500;
  }
}
