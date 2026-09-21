/**
 * Wire-level guard for module personalSettings over `google.protobuf.Struct`
 * (5th recurrence of the GAP-PRODUCTS-160 landmine — see
 * product/src/product/prefill-struct.spec.ts for the pattern).
 *
 * The TODO-449/TODO-492 chains were invisible to unit tests because every spec
 * mocked the gRPC boundary — both sides agreed on a plain JS map, and only the
 * SERIALIZER disagreed, silently encoding it to an empty Struct. These tests
 * round-trip through the real proto descriptor with the real loader options of
 * BOTH peers (control/src/main.ts and gateway/src/bff/grpc-bff.module.ts) and
 * assert the values actually survive the wire.
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

// control server options (control/src/main.ts) / gateway client options
// (gateway/src/bff/grpc-bff.module.ts).
const controlOpts = { keepCase: true, longs: Number };
const gatewayOpts = { keepCase: true, arrays: true, longs: Number };

// Realistic search settings: number, bool FALSE (the dangerous default-value
// case), string and a nested string list.
const SETTINGS = {
  minQueryChars: 5,
  hotkeyEnabled: false,
  theme: 'dense',
  indexableTypes: ['contact', 'deal'],
};

describe('module personalSettings Struct wire (TODO-449 / TODO-492)', () => {
  const controlSvc = load(controlOpts)['fairflow.control.v1.ProjectGrpc'];
  const gatewaySvc = load(gatewayOpts)['fairflow.control.v1.ProjectGrpc'];

  it('REGRESSION: a plain map is dropped by the Struct serializer', () => {
    const set = gatewaySvc.SetModulePersonalSettings;
    const decoded = set.requestDeserialize(
      set.requestSerialize({ project_id: 'p1', module_id: 'search', personal_settings: SETTINGS }),
    );
    // No exception, no warning — the field simply arrives empty.
    expect(structToJson(decoded.personal_settings)).toEqual({});
  });

  it('Set request survives gateway→control when encoded', () => {
    const sent = gatewaySvc.SetModulePersonalSettings.requestSerialize({
      project_id: 'p1',
      module_id: 'search',
      personal_settings: jsonToStruct(SETTINGS),
      actor_user_id: 'u1',
    });
    const received = controlSvc.SetModulePersonalSettings.requestDeserialize(sent);
    expect(received.project_id).toBe('p1');
    expect(structToJson(received.personal_settings)).toEqual(SETTINGS);
  });

  it('Set/Get response survives control→gateway when encoded', () => {
    for (const rpc of ['SetModulePersonalSettings', 'GetModulePersonalSettings'] as const) {
      const sent = controlSvc[rpc].responseSerialize({
        personal_settings: jsonToStruct(SETTINGS),
      });
      const received = gatewaySvc[rpc].responseDeserialize(sent);
      expect(structToJson(received.personal_settings)).toEqual(SETTINGS);
    }
  });

  it('keeps "cleared to {}" decodable and codec is lossless standalone', () => {
    const set = controlSvc.SetModulePersonalSettings;
    const cleared = set.responseDeserialize(
      set.responseSerialize({ personal_settings: jsonToStruct({}) }),
    );
    expect(structToJson(cleared.personal_settings)).toEqual({});
    // Pure codec sanity, including nesting the wire can carry.
    const nested = { a: 1, b: false, c: null, d: ['x', 2, true], e: { f: 'g' } };
    expect(structToJson(jsonToStruct(nested))).toEqual(nested);
  });

  it('tolerates a plain map from an older peer (mixed-version rollout)', () => {
    expect(structToJson(SETTINGS)).toEqual(SETTINGS);
    expect(structToJson(undefined)).toEqual({});
    expect(structToJson(null)).toEqual({});
  });
});
