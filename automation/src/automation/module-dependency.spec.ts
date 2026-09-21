import { flatRuleRequiredModules, missingModules } from './module-dependency';

describe('module-dependency', () => {
  it('collects trigger and action modules from flat rule', () => {
    const mods = flatRuleRequiredModules(
      'event',
      JSON.stringify({ event_name: 'crm.contact.created' }),
      JSON.stringify([{ type: 'create_activity' }]),
    );
    expect(mods).toEqual(expect.arrayContaining(['contacts', 'activities']));
  });

  it('reports missing modules', () => {
    expect(missingModules(['deals', 'contacts'], ['deals'])).toEqual(['contacts']);
  });
});
