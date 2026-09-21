import { legacyRulePatch, migrateConditionsJson } from './legacy-rule-migrate';

describe('legacyRulePatch (FR-AUTOM-010)', () => {
  it('normalizes catalog trigger id to event + event_name', () => {
    const patch = legacyRulePatch({
      trigger_type: 'crm.deal.created',
      trigger_config_json: '{}',
      conditions_json: '{"and":[]}',
    });
    expect(patch).toEqual({
      trigger_type: 'event',
      trigger_config_json: JSON.stringify({ event_name: 'crm.deal.created' }),
    });
  });

  it('migrates legacy {op,args} conditions', () => {
    const migrated = migrateConditionsJson(
      JSON.stringify({ op: 'and', args: [{ field: 'x', op: 'ne', value: 1 }] }),
    );
    expect(migrated).toBe(JSON.stringify({ and: [{ field: 'x', op: 'neq', value: 1 }] }));
  });

  it('skips v2 rules', () => {
    expect(legacyRulePatch({ engine_version: 2, trigger_type: 'crm.deal.created' })).toBeNull();
  });
});
