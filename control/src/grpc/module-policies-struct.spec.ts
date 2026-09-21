/**
 * Wire-level guard for module_policies[].condition over `google.protobuf.Struct`
 * (GAP-STRUCT-POLICIES — same landmine as personalSettings, module-settings-struct.spec.ts).
 */
import { join } from 'node:path';
import { loadSync } from '@grpc/proto-loader';
import { jsonToStruct, structToJson } from './struct-codec';

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

const load = (opts: Record<string, unknown>) =>
  loadSync(PROTO, opts) as unknown as Record<string, Record<string, Codec>>;

const controlOpts = { keepCase: true, longs: Number };
const gatewayOpts = { keepCase: true, arrays: true, longs: Number };

const CONDITION = {
  op: 'lt',
  left: { ref: 'record.amount' },
  right: { lit: 1_000_000 },
};

const POLICY = {
  id: 'rule-1',
  module_id: 'deals',
  effect: 'allow',
  subject: 'deals',
  action: 'read',
  resource: '*',
  condition: CONDITION,
};

describe('module_policies condition Struct wire (GAP-STRUCT-POLICIES)', () => {
  const controlSvc = load(controlOpts)['fairflow.control.v1.ProjectGrpc'];
  const gatewaySvc = load(gatewayOpts)['fairflow.control.v1.ProjectGrpc'];

  it('REGRESSION: a plain condition map is dropped by the Struct serializer', () => {
    const update = gatewaySvc.UpdateProject;
    const decoded = update.requestDeserialize(
      update.requestSerialize({
        id: 'p1',
        module_policies: [POLICY],
      }),
    );
    const rules = decoded.module_policies as Array<{ condition?: unknown }>;
    expect(structToJson(rules[0].condition)).toEqual({});
  });

  it('UpdateProject request survives gateway→control when condition is encoded', () => {
    const sent = gatewaySvc.UpdateProject.requestSerialize({
      id: 'p1',
      module_policies: [
        {
          ...POLICY,
          condition: jsonToStruct(CONDITION),
        },
      ],
    });
    const received = controlSvc.UpdateProject.requestDeserialize(sent);
    const rules = received.module_policies as Array<{ condition?: unknown }>;
    expect(structToJson(rules[0].condition)).toEqual(CONDITION);
  });

  it('GetProject response survives control→gateway when condition is encoded', () => {
    const sent = controlSvc.GetProject.responseSerialize({
      id: 'p1',
      module_policies: [
        {
          ...POLICY,
          condition: jsonToStruct(CONDITION),
        },
      ],
    });
    const received = gatewaySvc.GetProject.responseDeserialize(sent);
    const rules = received.module_policies as Array<{ condition?: unknown }>;
    expect(structToJson(rules[0].condition)).toEqual(CONDITION);
  });
});
