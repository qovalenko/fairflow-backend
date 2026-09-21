import { AutomationService } from './automation.service';

/** NFR-510 — project isolation: rule reads always include project_id in the filter. */
describe('AutomationService project isolation (NFR-510)', () => {
  it('getRule scopes findOne by project_id (foreign project cannot load the rule)', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const mongo = {
      rules: () => ({ findOne }),
    };
    const svc = new AutomationService(
      mongo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { isThrottled: jest.fn(async () => false) } as never,
      { notify: jest.fn(async () => true) } as never,
      {} as never,
    );
    await svc.getRule('proj-a', 'rule-1').catch(() => undefined);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'proj-a', id: 'rule-1' }),
    );
  });
});
