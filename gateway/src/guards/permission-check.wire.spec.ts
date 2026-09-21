import { join } from 'node:path';
import { loadSync } from '@grpc/proto-loader';
import { loadPackageDefinition, type ServiceDefinition } from '@grpc/grpc-js';
import { ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import { ProjectAccessGuard, invalidateProjectAccessCache } from './project-access.guard';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import { SKIP_PROJECT_SCOPE_KEY } from './skip-project-scope.decorator';

/**
 * TODO-027 / loader-canon. The project has been bitten FOUR times by a gRPC
 * loader registered without the full option set (`keepCase:true` dropped every
 * snake_case field; a missing `longs:Number` turned every int64 into a `Long`
 * object that TypeScript happily typed as `number`). The new `CheckPermissions`
 * call decides 403s, so a silently dropped field here would either open a route
 * or lock everyone out.
 *
 * This suite round-trips a real `CheckPermissionsResponse` through the REAL
 * proto with the REAL gateway loader options and feeds the decoded object to the
 * guard — request keys, response keys and the int64 epoch are all pinned by
 * construction rather than by hand-written fixtures.
 */

// Byte-for-byte the options of gateway/src/bff/grpc-bff.module.ts.
const LOADER_OPTIONS = { keepCase: true, arrays: true, longs: Number } as const;
const PROTO = join(
  __dirname,
  '..',
  '..',
  '..',
  'proto',
  'fairflow',
  'control',
  'v1',
  'control.proto',
);

type Codec = {
  requestSerialize: (v: unknown) => Buffer;
  requestDeserialize: (b: Buffer) => Record<string, unknown>;
  responseSerialize: (v: unknown) => Buffer;
  responseDeserialize: (b: Buffer) => Record<string, unknown>;
};

function checkPermissionsCodec(): Codec {
  const def = loadSync(PROTO, {
    ...LOADER_OPTIONS,
    includeDirs: [join(__dirname, '..', '..', '..', 'proto')],
  });
  const pkg = loadPackageDefinition(def) as unknown as {
    fairflow: { control: { v1: { RoleGrpc: { service: ServiceDefinition } } } };
  };
  return pkg.fairflow.control.v1.RoleGrpc.service.CheckPermissions as unknown as Codec;
}

describe('CheckPermissions wire contract (keepCase + longs)', () => {
  const codec = checkPermissionsCodec();

  it('carries the request the guard builds (snake_case survives the round-trip)', () => {
    const sent = {
      project_id: 'p-1',
      user_id: 'u-1',
      checks: [{ subject: 'deals', action: 'delete' }],
    };
    const decoded = codec.requestDeserialize(codec.requestSerialize(sent));
    expect(decoded).toMatchObject(sent);
    // camelCase would be dropped on the wire — assert the canon explicitly.
    expect(decoded).not.toHaveProperty('projectId');
  });

  it('decodes decisions, the not_applicable flag and the int64 epoch as a number', () => {
    const decoded = codec.responseDeserialize(
      codec.responseSerialize({
        decisions: [
          {
            subject: 'contacts',
            action: 'export',
            decision: 'deny',
            reason: 'DENIED_BY_GRANT',
            matched_keys: ['contacts:export'],
            not_applicable: false,
          },
        ],
        role: 'manager',
        epoch: 1_756_000_000_000,
      }),
    );
    const decision = (decoded.decisions as Array<Record<string, unknown>>)[0];
    expect(decision).toMatchObject({
      subject: 'contacts',
      action: 'export',
      decision: 'deny',
      reason: 'DENIED_BY_GRANT',
      not_applicable: false,
    });
    expect(decision.matched_keys).toEqual(['contacts:export']);
    // `longs: Number` — not a Long {low, high, unsigned} object (rake #4).
    expect(typeof decoded.epoch).toBe('number');
    expect(decoded.epoch).toBe(1_756_000_000_000);
  });

  it('a decision left at proto3 defaults decodes to a DENY, never an abstain', () => {
    const decoded = codec.responseDeserialize(
      codec.responseSerialize({ decisions: [{ subject: 'deals', action: 'read' }] }),
    );
    const decision = (decoded.decisions as Array<Record<string, unknown>>)[0];
    // proto-loader omits default-valued scalars entirely (no `defaults:true` in
    // the canon options): both fields arrive as `undefined`, which the PEP must
    // read as "not allowed" and "applicable" — i.e. a denial.
    expect(decision.decision).toBeUndefined();
    expect(decision.not_applicable).toBeUndefined();
  });

  // ── the guard consuming exactly what the wire produces ───────────────────────

  describe('guard fed with wire-decoded responses', () => {
    const outboundMeta = { build: jest.fn(() => ({})) };
    const makeGuard = (
      required: unknown,
      checkPermissions: jest.Mock,
      role = 'manager',
    ): ProjectAccessGuard =>
      new ProjectAccessGuard(
        {
          getAllAndOverride: (key: unknown) => {
            if (key === REQUIRED_PERMISSION_KEY) return required;
            if (key === SKIP_PROJECT_SCOPE_KEY) return undefined;
            return undefined;
          },
        } as never,
        {
          getService: () => ({
            resolveRecordVisibility: jest.fn(() => of({ allowed: true, role, epoch: 1 })),
            getProjectAccessEpoch: jest.fn(() => of({ epoch: 1 })),
            getProject: jest.fn(() => of({ effective_modules: [], module_policies: [] })),
            checkPermissions,
          }),
        } as never,
        outboundMeta as never,
      );

    const context = () =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-wire' } }),
        }),
        getHandler: () => undefined,
        getClass: () => undefined,
      }) as never;

    /** Control's reply, encoded and decoded exactly as grpc-js would. */
    const wire = (payload: unknown) =>
      jest.fn(() => of(codec.responseDeserialize(codec.responseSerialize(payload))));

    beforeEach(() => {
      process.env.GATEWAY_ACCESS_CACHE_TTL_MS = '0';
      process.env.GATEWAY_POLICY_CACHE_TTL_MS = '0';
      process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '0';
      process.env.GATEWAY_PDP_CACHE_TTL_MS = '0';
      invalidateProjectAccessCache('p-wire');
    });

    it('403s on a wire-encoded deny', async () => {
      const guard = makeGuard(
        { subject: 'contacts', action: 'export' },
        wire({
          decisions: [
            {
              subject: 'contacts',
              action: 'export',
              decision: 'deny',
              reason: 'DENIED_BY_GRANT',
            },
          ],
          epoch: 5,
        }),
      );
      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('passes a wire-encoded allow', async () => {
      const guard = makeGuard(
        { subject: 'deals', action: 'read' },
        wire({
          decisions: [{ subject: 'deals', action: 'read', decision: 'allow', reason: 'OK' }],
          epoch: 5,
        }),
      );
      await expect(guard.canActivate(context())).resolves.toBe(true);
    });

    it('honours a wire-encoded not_applicable (flat matrix keeps the route alive)', async () => {
      const guard = makeGuard(
        { subject: 'statistics', action: 'export' },
        wire({
          decisions: [
            {
              subject: 'statistics',
              action: 'export',
              decision: 'deny',
              reason: 'NO_CATALOG_KEY',
              not_applicable: true,
            },
          ],
          epoch: 5,
        }),
      );
      await expect(guard.canActivate(context())).resolves.toBe(true);
    });

    it('403s on a wire-encoded empty response (proto3 defaults only)', async () => {
      const guard = makeGuard({ subject: 'deals', action: 'read' }, wire({}));
      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403s when the decision itself is all-defaults on the wire', async () => {
      // A control that answered the pair but set nothing: `decision` and
      // `not_applicable` are absent after decoding — must NOT become an abstain.
      const guard = makeGuard(
        { subject: 'deals', action: 'read' },
        wire({ decisions: [{ subject: 'deals', action: 'read' }] }),
      );
      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
