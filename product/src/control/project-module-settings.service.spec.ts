import { of, throwError } from 'rxjs';
import { ProjectModuleSettingsService } from './project-module-settings.service';

function makeService(
  integrationSettings?: Record<string, unknown> | 'error',
  moduleId = 'products',
) {
  const getModuleIntegrationSettings = jest.fn(() => {
    if (integrationSettings === 'error') return throwError(() => new Error('control down'));
    return of({ integration_settings: integrationSettings ?? { defaultCurrency: 'EUR' } });
  });
  const client = { getService: jest.fn(() => ({ getModuleIntegrationSettings })) };
  const svc = new ProjectModuleSettingsService(client as never);
  svc.onModuleInit();
  return { svc, getModuleIntegrationSettings, moduleId };
}

describe('ProjectModuleSettingsService', () => {
  it('loads integration settings from control and caches them', async () => {
    const { svc, getModuleIntegrationSettings } = makeService({ defaultCurrency: 'USD' });
    await expect(svc.getIntegrationSettings('p1')).resolves.toEqual({ defaultCurrency: 'USD' });
    await expect(svc.getIntegrationSettings('p1')).resolves.toEqual({ defaultCurrency: 'USD' });
    expect(getModuleIntegrationSettings).toHaveBeenCalledTimes(1);
  });

  it('returns empty settings when control is down (fail-soft)', async () => {
    const { svc } = makeService('error');
    await expect(svc.getIntegrationSettings('p1')).resolves.toEqual({});
  });

  it('defaultCurrency falls back to RUB when settings are empty', async () => {
    const { svc } = makeService({});
    await expect(svc.defaultCurrency('p1')).resolves.toBe('RUB');
  });

  it('defaultCurrency trims project integrationSettings.defaultCurrency', async () => {
    const { svc } = makeService({ defaultCurrency: '  CHF  ' });
    await expect(svc.defaultCurrency('p1')).resolves.toBe('CHF');
  });
});
