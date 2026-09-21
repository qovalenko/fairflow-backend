import { buildGatewayOutboundMetadata, buildServiceOutboundMetadata } from './outbound-metadata';
import { GW_METADATA } from './metadata-keys';
import { readAccessPredicate, readCallId } from './inbound-metadata';
import { parseEnabledModulesHeader } from '../module-gating';
import { serializeCompiledPredicate } from '../abac/predicate';

const BASE = {
  serviceApiKey: 'ak_test',
  gatewayApiKeyId: 'kid_test',
  headers: {} as Record<string, string | string[] | undefined>,
  actorType: 'user' as const,
  userId: 'u1',
  projectId: 'p1',
};

describe('buildGatewayOutboundMetadata — x-access-predicate', () => {
  it('omits x-access-predicate when accessPredicate is absent', () => {
    const md = buildGatewayOutboundMetadata({ ...BASE });
    expect(md.get(GW_METADATA.ACCESS_PREDICATE)).toEqual([]);
    // Consumer sees an absent header → no ABAC narrowing.
    expect(readAccessPredicate(md)).toEqual({ present: false });
  });

  it('omits x-access-predicate for an empty string', () => {
    const md = buildGatewayOutboundMetadata({ ...BASE, accessPredicate: '' });
    expect(md.get(GW_METADATA.ACCESS_PREDICATE)).toEqual([]);
  });

  it('sets x-access-predicate verbatim when present and round-trips via readAccessPredicate', () => {
    const serialized = serializeCompiledPredicate({
      ir: null,
      mongo: { amount: { $lt: 1_000_000 } },
    });
    const md = buildGatewayOutboundMetadata({ ...BASE, accessPredicate: serialized });
    expect(md.get(GW_METADATA.ACCESS_PREDICATE)).toEqual([serialized]);
    const parsed = readAccessPredicate(md);
    expect(parsed).toMatchObject({
      present: true,
      mongo: { amount: { $lt: 1_000_000 } },
      ir: null,
    });
  });
});

describe('TODO-475: x-gw-call-id — серверный идентификатор вызова', () => {
  it('чеканится на каждую сборку и НЕ берётся из клиентского x-request-id', () => {
    const headers = { 'x-request-id': 'pinned-by-client' };
    const a = buildGatewayOutboundMetadata({ ...BASE, headers });
    const b = buildGatewayOutboundMetadata({ ...BASE, headers });
    // x-request-id клиент фиксирует — это трассировка, а не идентичность вызова.
    expect(a.get(GW_METADATA.REQUEST_ID)).toEqual(['pinned-by-client']);
    expect(b.get(GW_METADATA.REQUEST_ID)).toEqual(['pinned-by-client']);
    // call-id обязан быть разным: иначе audit схлопнет две осознанные выгрузки
    // в один факт statistics.exported (FR-MSTAT-23).
    expect(readCallId(a)).toBeTruthy();
    expect(readCallId(b)).toBeTruthy();
    expect(readCallId(a)).not.toBe(readCallId(b));
  });

  it('клиент не может подсунуть свой x-gw-call-id заголовком', () => {
    const md = buildGatewayOutboundMetadata({
      ...BASE,
      headers: { 'x-gw-call-id': 'attacker', 'idempotency-key': 'attacker-idem' },
    });
    expect(readCallId(md)).not.toBe('attacker');
    expect(readCallId(md)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('s2s-метадата тоже несёт собственный call-id', () => {
    const a = buildServiceOutboundMetadata({ serviceApiKey: 'ak_test' });
    const b = buildServiceOutboundMetadata({ serviceApiKey: 'ak_test' });
    expect(readCallId(a)).toBeTruthy();
    expect(readCallId(a)).not.toBe(readCallId(b));
  });
});

/**
 * [review-1] `x-enabled-modules` is THREE-state on the wire, because the search
 * domain's only module gate (types ∩ enabled modules — /search/query has no
 * @RequireModule by design, T-018) has to tell "nothing is enabled" from "the
 * gateway said nothing". Gating the header on a non-empty array collapsed those
 * two into one and disarmed the gate in the degraded case.
 */
describe('buildGatewayOutboundMetadata — x-enabled-modules (three-state)', () => {
  it('omits the header when the caller has no module context at all', () => {
    const md = buildGatewayOutboundMetadata({ ...BASE });
    expect(md.get(GW_METADATA.ENABLED_MODULES)).toEqual([]);
    expect(parseEnabledModulesHeader(md.get(GW_METADATA.ENABLED_MODULES)[0])).toBeUndefined();
  });

  it('emits an EXPLICIT empty set as "[]" (resolved, and nothing is enabled)', () => {
    const md = buildGatewayOutboundMetadata({ ...BASE, enabledModules: [] });
    expect(md.get(GW_METADATA.ENABLED_MODULES)).toEqual(['[]']);
    // The consumer must see [] — not undefined — so it can fail closed.
    expect(parseEnabledModulesHeader(md.get(GW_METADATA.ENABLED_MODULES)[0])).toEqual([]);
  });

  it('emits a populated set verbatim', () => {
    const md = buildGatewayOutboundMetadata({ ...BASE, enabledModules: ['deals', 'contacts'] });
    expect(parseEnabledModulesHeader(md.get(GW_METADATA.ENABLED_MODULES)[0])).toEqual([
      'deals',
      'contacts',
    ]);
  });
});
