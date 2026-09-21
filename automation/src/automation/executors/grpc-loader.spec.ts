import { loadSync, type Options } from '@grpc/proto-loader';
import { AUTOMATION_GRPC_LOADER_OPTIONS, protoPath } from './grpc-action-executor';

/**
 * Regression guard for the twice-stepped-on keepCase rake (July 401 hunt).
 *
 * A gRPC client created WITHOUT loader options runs with `keepCase: false`:
 * protobufjs renames every proto field to camelCase, so a request object with
 * snake_case keys (`project_id`, `assignee_id` — the shape ALL our code passes)
 * matches no field and serializes to an EMPTY message. Nothing throws — the
 * fields just vanish on the wire.
 *
 * These tests serialize real requests through the real protos with
 * {@link AUTOMATION_GRPC_LOADER_OPTIONS} and assert the snake_case fields
 * survive a round-trip — and demonstrate that the default options lose them,
 * so the failure mode stays documented and executable.
 */

type Serde = {
  requestSerialize: (v: Record<string, unknown>) => Buffer;
  requestDeserialize: (b: Buffer) => Record<string, unknown>;
};

function methodSerde(
  proto: string[],
  serviceFq: string,
  method: string,
  options: Options,
): Serde {
  const def = loadSync(protoPath(...proto), options);
  const service = def[serviceFq] as unknown as Record<string, Serde>;
  return service[method];
}

describe('automation gRPC loader options (keepCase regression, R4 grabli)', () => {
  it('exports keepCase:true (+arrays, matching the gateway loader)', () => {
    expect(AUTOMATION_GRPC_LOADER_OPTIONS.keepCase).toBe(true);
    expect(AUTOMATION_GRPC_LOADER_OPTIONS.arrays).toBe(true);
  });

  it('CreateActivity keeps project_id/assignee_id on the wire with our options', () => {
    const serde = methodSerde(
      ['fairflow', 'activity', 'v1', 'activity.proto'],
      'fairflow.activity.v1.ActivityGrpc',
      'CreateActivity',
      AUTOMATION_GRPC_LOADER_OPTIONS,
    );
    const req = {
      project_id: 'p1',
      title: 'Автозадача',
      assignee_id: 'user-42',
      deal_id: 'd1',
      created_by_rule: { rule_id: 'r9', name: 'Rule nine' },
    };
    const bytes = serde.requestSerialize(req);
    expect(bytes.length).toBeGreaterThan(0);
    const back = serde.requestDeserialize(bytes);
    expect(back.project_id).toBe('p1');
    expect(back.assignee_id).toBe('user-42');
    expect(back.deal_id).toBe('d1');
    expect(back.created_by_rule).toEqual({ rule_id: 'r9', name: 'Rule nine' });
  });

  it('ListModuleStates keeps project_id on the wire with our options', () => {
    const serde = methodSerde(
      ['fairflow', 'control', 'v1', 'control.proto'],
      'fairflow.control.v1.ModuleLifecycleControlGrpc',
      'ListModuleStates',
      AUTOMATION_GRPC_LOADER_OPTIONS,
    );
    const bytes = serde.requestSerialize({ project_id: 'p1' });
    expect(bytes.length).toBeGreaterThan(0);
    expect(serde.requestDeserialize(bytes).project_id).toBe('p1');
  });

  it('DOCUMENTS THE RAKE: default loader (keepCase:false) silently drops snake_case fields', () => {
    const serde = methodSerde(
      ['fairflow', 'control', 'v1', 'control.proto'],
      'fairflow.control.v1.ModuleLifecycleControlGrpc',
      'ListModuleStates',
      {}, // ClientGrpcProxy without loader options behaves like this
    );
    // The exact request our resolver sends — serialized to NOTHING.
    const bytes = serde.requestSerialize({ project_id: 'p1' });
    expect(bytes.length).toBe(0);
  });
});
