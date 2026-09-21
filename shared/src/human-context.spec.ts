import { buildHumanContext } from './human-context';

describe('buildHumanContext (FR-NOTIF-215)', () => {
  it('prefers humanContext.displayName when present', () => {
    expect(
      buildHumanContext({ humanContext: { displayName: 'ООО Ромашка' }, dealId: 'd-1' }, ['dealId']),
    ).toEqual({ displayName: 'ООО Ромашка', amount: undefined, actorName: undefined });
  });

  it('falls back to flat name fields', () => {
    expect(buildHumanContext({ dealName: 'Сделка 42' }, ['dealId'])).toEqual(
      expect.objectContaining({ displayName: 'Сделка 42' }),
    );
  });
});
