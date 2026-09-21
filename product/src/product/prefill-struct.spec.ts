/**
 * GAP-PRODUCTS-160 — wire-level guard for `Product.prefill` (google.protobuf.Struct).
 *
 * The bug was invisible in unit tests because both sides agreed on a plain JS map —
 * only the SERIALIZER disagreed, silently encoding it to zero bytes. So this test
 * round-trips through the real proto descriptor with the real loader options
 * (`keepCase: true`, as in gateway/grpc-bff.module.ts and product/main.ts) and
 * asserts that the values actually survive the wire in both directions.
 */
import { join } from 'node:path';
import { loadSync } from '@grpc/proto-loader';
import { prefillFromStruct, prefillToStruct } from './prefill-struct';

const PROTO = join(
  __dirname,
  '..',
  '..',
  '..',
  'proto',
  'fairflow',
  'product',
  'v1',
  'product.proto',
);

type Codec = {
  requestSerialize: (v: unknown) => Buffer;
  requestDeserialize: (b: Buffer) => Record<string, unknown>;
};

const pkg = loadSync(PROTO, { keepCase: true, arrays: true }) as unknown as Record<
  string,
  Record<string, Codec>
>;
const CreateProduct = pkg['fairflow.product.v1.ProductGrpc'].CreateProduct;

const roundTrip = (payload: Record<string, unknown>) =>
  CreateProduct.requestDeserialize(CreateProduct.requestSerialize(payload));

describe('GAP-PRODUCTS-160 prefill Struct codec', () => {
  it('REGRESSION: a plain map is dropped by the Struct serializer', () => {
    // This is the bug: no exception, no warning — the field simply vanishes.
    const decoded = roundTrip({ project_id: 'p1', prefill: { inn: '7701', qty: 2 } });
    expect(prefillFromStruct(decoded.prefill)).toEqual({});
  });

  it('survives the wire when encoded as a Struct', () => {
    const original = { inn: '7701', qty: 2, vip: true };
    const decoded = roundTrip({ project_id: 'p1', prefill: prefillToStruct(original) });
    expect(prefillFromStruct(decoded.prefill)).toEqual(original);
  });

  it('keeps "omitted" distinguishable from "cleared to {}"', () => {
    expect(prefillFromStruct(roundTrip({ project_id: 'p1' }).prefill)).toBeUndefined();
    expect(
      prefillFromStruct(roundTrip({ project_id: 'p1', prefill: prefillToStruct({}) }).prefill),
    ).toEqual({});
  });

  it('tolerates a plain map from an older peer (mixed-version rollout)', () => {
    expect(prefillFromStruct({ inn: '7701', qty: 2 })).toEqual({ inn: '7701', qty: 2 });
  });

  it('drops non-scalar values instead of emitting an unencodable Value', () => {
    expect(prefillToStruct({ ok: 'x', nested: { a: 1 }, list: [1] })).toEqual({
      fields: { ok: { stringValue: 'x' } },
    });
  });

  /**
   * X5 — the two copies of this codec (here and gateway/src/bff/crm-bff.controller.ts)
   * must encode `null` the same way. The gateway copy already dropped it; this one
   * emitted `{nullValue: 0}`, which NEITHER decoder understands — so the key came back
   * missing, an asymmetric round-trip that depended on which copy did the encoding.
   */
  it('drops null instead of emitting {nullValue} no decoder reads back', () => {
    expect(prefillToStruct({ ok: 'x', gone: null })).toEqual({
      fields: { ok: { stringValue: 'x' } },
    });
    // …and the drop is symmetric on the wire: encode → decode loses the key entirely.
    const decoded = roundTrip({
      project_id: 'p1',
      prefill: prefillToStruct({ ok: 'x', gone: null }),
    });
    expect(prefillFromStruct(decoded.prefill)).toEqual({ ok: 'x' });
  });
});
