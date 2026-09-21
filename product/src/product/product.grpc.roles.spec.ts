import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { GrpcRolesGuard, REQUIRE_ROLES_KEY } from '@fairflow/shared';
import { ProductGrpcController } from './product.grpc.controller';

function makeGuard(): GrpcRolesGuard {
  return new GrpcRolesGuard(new Reflector());
}

function makeContext(
  handler: (...args: unknown[]) => unknown,
  metadata: Metadata,
): {
  getType: () => string;
  getHandler: () => typeof handler;
  getClass: () => unknown;
  getArgByIndex: (i: number) => unknown;
} {
  return {
    getType: () => 'rpc',
    getHandler: () => handler,
    getClass: () => ProductGrpcController,
    getArgByIndex: (i: number) => (i === 1 ? metadata : undefined),
  };
}

function metadataWithRole(role: string): Metadata {
  const md = new Metadata();
  md.set('x-roles', role);
  return md;
}

describe('ProductGrpcController role gates (FR-PRODUCTS-250)', () => {
  const guard = makeGuard();
  const proto = ProductGrpcController.prototype;

  it('Create/Update/Archive/Restore are annotated manager+; Delete is admin+', () => {
    expect(Reflect.getMetadata(REQUIRE_ROLES_KEY, proto.create)).toBe('manager');
    expect(Reflect.getMetadata(REQUIRE_ROLES_KEY, proto.update)).toBe('manager');
    expect(Reflect.getMetadata(REQUIRE_ROLES_KEY, proto.archive)).toBe('manager');
    expect(Reflect.getMetadata(REQUIRE_ROLES_KEY, proto.restore)).toBe('manager');
    expect(Reflect.getMetadata(REQUIRE_ROLES_KEY, proto.delete)).toBe('admin');
    expect(Reflect.getMetadata(REQUIRE_ROLES_KEY, proto.list)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_ROLES_KEY, proto.get)).toBeUndefined();
  });

  it('member cannot pass CreateProduct (manager+ required)', () => {
    expect(() =>
      guard.canActivate(makeContext(proto.create, metadataWithRole('member')) as never),
    ).toThrow(RpcException);
  });

  it('manager passes CreateProduct', () => {
    expect(guard.canActivate(makeContext(proto.create, metadataWithRole('manager')) as never)).toBe(
      true,
    );
  });

  it('manager cannot pass DeleteProduct (admin+ required)', () => {
    expect(() =>
      guard.canActivate(makeContext(proto.delete, metadataWithRole('manager')) as never),
    ).toThrow(RpcException);
  });

  it('admin passes DeleteProduct', () => {
    expect(guard.canActivate(makeContext(proto.delete, metadataWithRole('admin')) as never)).toBe(
      true,
    );
  });
});
