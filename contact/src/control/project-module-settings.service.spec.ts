import { of, throwError } from 'rxjs';
import { ProjectModuleSettingsService } from './project-module-settings.service';

describe('ProjectModuleSettingsService (FR-CONTACTS-520)', () => {
  const prevTtl = process.env.CONTACT_MODULE_SETTINGS_TTL_MS;

  afterEach(() => {
    if (prevTtl === undefined) delete process.env.CONTACT_MODULE_SETTINGS_TTL_MS;
    else process.env.CONTACT_MODULE_SETTINGS_TTL_MS = prevTtl;
  });

  function build(personal: Record<string, unknown>, integration: Record<string, unknown>) {
    const getModulePersonalSettings = jest.fn(() =>
      of({ personal_settings: { fields: personal } }),
    );
    const getModuleIntegrationSettings = jest.fn(() =>
      of({ integration_settings: { fields: integration } }),
    );
    const client = {
      getService: () => ({ getModulePersonalSettings, getModuleIntegrationSettings }),
    };
    const svc = new ProjectModuleSettingsService(client as never);
    svc.onModuleInit();
    return { svc, getModulePersonalSettings, getModuleIntegrationSettings };
  }

  it('merges integration then personal (personal wins on conflict)', async () => {
    const { svc } = build(
      { duplicateCheck: true, importRowLimit: 500 },
      { duplicateCheck: false, webhookUrl: 'https://x' },
    );
    await expect(svc.getIntegrationSettings('p1')).resolves.toEqual({
      duplicateCheck: true,
      importRowLimit: 500,
      webhookUrl: 'https://x',
    });
  });

  it('caches settings within TTL — second call skips control gRPC', async () => {
    process.env.CONTACT_MODULE_SETTINGS_TTL_MS = '60000';
    const { svc, getModulePersonalSettings, getModuleIntegrationSettings } = build(
      { importRowLimit: 100 },
      {},
    );
    await svc.getIntegrationSettings('p1');
    await svc.getIntegrationSettings('p1');
    expect(getModulePersonalSettings).toHaveBeenCalledTimes(1);
    expect(getModuleIntegrationSettings).toHaveBeenCalledTimes(1);
  });

  it('returns {} and caches empty settings when both control calls fail', async () => {
    process.env.CONTACT_MODULE_SETTINGS_TTL_MS = '60000';
    const getModulePersonalSettings = jest.fn(() => throwError(() => new Error('timeout')));
    const getModuleIntegrationSettings = jest.fn(() => throwError(() => new Error('timeout')));
    const client = {
      getService: () => ({ getModulePersonalSettings, getModuleIntegrationSettings }),
    };
    const svc = new ProjectModuleSettingsService(client as never);
    svc.onModuleInit();

    await expect(svc.getIntegrationSettings('p1')).resolves.toEqual({});
    await svc.getIntegrationSettings('p1');
    expect(getModulePersonalSettings).toHaveBeenCalledTimes(1);
  });

  it('uses default module id "contacts" when not specified', async () => {
    const getModulePersonalSettings = jest.fn(() => of({ personal_settings: undefined }));
    const getModuleIntegrationSettings = jest.fn(() => of({ integration_settings: undefined }));
    const client = {
      getService: () => ({ getModulePersonalSettings, getModuleIntegrationSettings }),
    };
    const svc = new ProjectModuleSettingsService(client as never);
    svc.onModuleInit();
    await svc.getIntegrationSettings('p1');
    expect(getModulePersonalSettings).toHaveBeenCalledWith(
      { project_id: 'p1', module_id: 'contacts' },
      expect.anything(),
    );
  });
});
