import { ReportsService } from './reports.service';

/**
 * Typed `params_json` parser (P2.f). The closed vocabulary is period/from/to/
 * pipelineId/stageId; unknown keys are dropped and a present-but-wrong-typed
 * known key is INVALID_ARGUMENT. Construction is dependency-free for this method
 * (no Mongo/gRPC touched by parseParams).
 */
describe('ReportsService.parseParams', () => {
  const svc = new ReportsService({} as never, {} as never, {} as never, {} as never, { read: async () => [] } as never, { get: async () => null, isTrusted: () => false } as never, { listForDeal: async () => [], avgDurationByStage: async () => [] } as never);
  const parse = (json?: string): Record<string, unknown> =>
    (svc as unknown as { parseParams(j?: string): Record<string, unknown> }).parseParams(json);

  it('returns {} for empty / missing input', () => {
    expect(parse()).toEqual({});
    expect(parse('')).toEqual({});
    expect(parse('   ')).toEqual({});
  });

  it('collapses non-object JSON (array/scalar/null) to {}', () => {
    expect(parse('[1,2]')).toEqual({});
    expect(parse('42')).toEqual({});
    expect(parse('null')).toEqual({});
  });

  it('keeps known typed fields including managerIds', () => {
    expect(
      parse(JSON.stringify({ period: 'month', from: 1, to: 2, pipelineId: 'pl1', stageId: 's1', managerIds: ['u1'] })),
    ).toEqual({ period: 'month', from: 1, to: 2, pipelineId: 'pl1', stageId: 's1', managerIds: ['u1'] });
  });

  it('drops unknown keys', () => {
    expect(parse(JSON.stringify({ period: 'week', rogue: 'x', nested: { a: 1 } }))).toEqual({
      period: 'week',
    });
  });

  it('drops empty/whitespace strings', () => {
    expect(parse(JSON.stringify({ period: '  ', pipelineId: '' }))).toEqual({});
  });

  it('throws INVALID_ARGUMENT on invalid JSON', () => {
    expect(() => parse('{not json')).toThrow(/valid JSON/);
  });

  it('throws INVALID_ARGUMENT when a known string field is not a string', () => {
    expect(() => parse(JSON.stringify({ period: 123 }))).toThrow(/period must be a string/);
  });

  it('throws INVALID_ARGUMENT when a known number field is not a finite number', () => {
    expect(() => parse(JSON.stringify({ from: 'soon' }))).toThrow(/from must be a finite number/);
  });
});
