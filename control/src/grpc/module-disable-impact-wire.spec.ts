/**
 * FR-SHELL-160: webhook_dlq_suspended must survive control → gateway proto-loader
 * (keepCase:true). Without the proto field the JS property is silently dropped.
 */
import { join } from 'node:path';
import { loadSync } from '@grpc/proto-loader';

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
  responseSerialize: (v: unknown) => Buffer;
  responseDeserialize: (b: Buffer) => Record<string, unknown>;
};

const load = (opts: Record<string, unknown>) =>
  loadSync(PROTO, opts) as unknown as Record<string, Record<string, Codec>>;

const controlOpts = { keepCase: true, longs: Number };
const gatewayOpts = { keepCase: true, arrays: true, longs: Number };

describe('GetModuleDisableImpact webhook_dlq_suspended wire (FR-SHELL-160)', () => {
  const controlSvc = load(controlOpts)['fairflow.control.v1.ProjectGrpc'];
  const gatewaySvc = load(gatewayOpts)['fairflow.control.v1.ProjectGrpc'];

  it('survives control→gateway serialization when true', () => {
    const sent = controlSvc.GetModuleDisableImpact.responseSerialize({
      dependent_enabled_modules: [],
      unfinished_records: 0,
      stopped_automations: [],
      webhook_dlq_suspended: true,
    });
    const received = gatewaySvc.GetModuleDisableImpact.responseDeserialize(sent);
    expect(received.webhook_dlq_suspended).toBe(true);
  });

  it('decodes false (not dropped as default-absent) for non-automation modules', () => {
    const sent = controlSvc.GetModuleDisableImpact.responseSerialize({
      webhook_dlq_suspended: false,
    });
    const received = gatewaySvc.GetModuleDisableImpact.responseDeserialize(sent);
    expect(received.webhook_dlq_suspended).toBe(false);
  });
});
