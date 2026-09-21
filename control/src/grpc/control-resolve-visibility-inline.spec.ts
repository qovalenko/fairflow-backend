/**
 * [#19] The ResolveRecordVisibility gRPC handler must forward `inline` to the
 * resolver (domain-side hydration path) and stay inline=false by default (gateway
 * path, oversized scopes defer). Focused test — stubs the unused controller deps.
 */
import { ControlGrpcController } from './control.grpc.controller';

function makeController(resolve: jest.Mock, epochGet: jest.Mock) {
  const stub = {} as never;
  return new ControlGrpcController(
    stub, // projects
    stub, // moduleDisableImpact
    stub, // lifecycle
    stub, // organizations
    stub, // structure
    stub, // departmentBindings
    stub, // invitations
    stub, // orgAudit
    { resolve } as never, // visibility
    stub, // shares
    stub, // users
    stub, // roles
    stub, // accessUnits
    { get: epochGet } as never, // accessEpoch
    stub, // pdp
    stub, // integrations
    stub, // seats
    stub, // orgPdp
    stub, // projectInvitations
  );
}

describe('[#19] ControlGrpcController.resolveRecordVisibility inline flag', () => {
  const resolved = {
    allowed: true,
    role: 'member',
    level: 'own_and_department',
    mode: 'restricted',
    ownerIds: ['u1', 'u2'],
    sharedRecordIds: [],
    deferred: false,
  };

  it('forwards inline=true to visibility.resolve', async () => {
    const resolve = jest.fn().mockResolvedValue(resolved);
    const epochGet = jest.fn().mockResolvedValue(42);
    const c = makeController(resolve, epochGet);
    const res = await c.resolveRecordVisibility({
      project_id: 'p1',
      user_id: 'u1',
      resource: 'contacts',
      inline: true,
    });
    expect(resolve).toHaveBeenCalledWith('p1', 'u1', 'contacts', { inline: true });
    expect(res.owner_ids).toEqual(['u1', 'u2']);
    expect(res.epoch).toBe(42);
    expect(res.deferred).toBe(false);
  });

  it('defaults inline=false (gateway path) when the flag is absent', async () => {
    const resolve = jest.fn().mockResolvedValue(resolved);
    const epochGet = jest.fn().mockResolvedValue(1);
    const c = makeController(resolve, epochGet);
    await c.resolveRecordVisibility({ project_id: 'p1', user_id: 'u1', resource: 'contacts' });
    expect(resolve).toHaveBeenCalledWith('p1', 'u1', 'contacts', { inline: false });
  });
});
