/**
 * [be-search] Gateway (BFF) слой модуля «Поиск»:
 *
 *  - TODO-088 — /search/query и /search/status получили PEP-гейт (`search:read` /
 *    `search:manage`); до этого право проверялось ТОЛЬКО на фронте (UX-гейт).
 *  - TODO-492 — сохранённые настройки модуля («Поиск» → personalSettings) теперь
 *    имеют ровно ОДНОГО читателя: gateway. Он складывает их в gRPC-запрос
 *    (per_type_limit / entity_types), в порог minQueryChars и в freshnessSlaMs
 *    ответа /search/status.
 *  - TODO-491 (часть gateway) — заголовок `Idempotency-Key` от FE уже уезжает в
 *    домен метадатой `idempotency-key`; тест фиксирует это как контракт, чтобы
 *    доменный лок реиндексации было на чём строить.
 */
import { of } from 'rxjs';
import { HttpException } from '@nestjs/common';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { GW_METADATA } from '@fairflow/shared';
import {
  CommonBffController,
  normalizeSearchSettings,
  resetSearchSettingsCache,
} from './common-bff.controller';
import { gatewaySearchQueryRateLimiter, SEARCH_QUERY_RATE } from './search-rate-limit';
import { REQUIRED_PERMISSION_KEY } from '../guards/require-permission.decorator';
import { REQUIRED_MODULE_KEY } from '../guards/require-module.decorator';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

/** control ProjectGrpc.GetProject stub with the project's saved search settings. */
function controlWithSettings(settings: Record<string, unknown> | null) {
  return stubClient({
    getProject: jest.fn(() =>
      of({
        id: 'p1',
        module_configs: settings
          ? [
              { module_id: 'deals', personal_settings: { foo: 1 } },
              { module_id: 'search', personal_settings: settings },
            ]
          : [],
      }),
    ),
  });
}

function build(
  search: Record<string, unknown>,
  control = stubClient(),
  audit: Record<string, unknown> = { appendEvent: jest.fn(() => of({ id: 'ev-0' })) },
) {
  const ctrl = new CommonBffController(
    stubClient(),
    stubClient(search),
    stubClient(audit),
    control,
    { build: () => ({}) } as never,
    { publishBadge: jest.fn(), subscribe: jest.fn() } as never,
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = (projectId = 'p1') =>
  ({ user: { userId: 'u1' }, headers: { 'x-project-id': projectId } }) as never;

beforeEach(() => resetSearchSettingsCache());

describe('[TODO-088] search routes carry a permission gate', () => {
  it('GET /search/query requires search:read', () => {
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, CommonBffController.prototype.search),
    ).toEqual({ subject: 'search', action: 'read' });
  });

  it('GET /search/status requires search:manage (index internals = admin read)', () => {
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, CommonBffController.prototype.searchStatus),
    ).toEqual({ subject: 'search', action: 'manage' });
  });

  it('POST /search/reindex keeps search:manage', () => {
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, CommonBffController.prototype.reindex),
    ).toEqual({ subject: 'search', action: 'manage' });
  });

  /**
   * T-018: `search` — cross-cutting возможность, её не включает ни один проект
   * (control `DEMO_SHOWCASE_MODULES`), поэтому `@RequireModule('search')` = вечный
   * 403 MODULE_DISABLED. query/settings/status гейт уже сняли, а reindex остался
   * заблокированным — при том, что вкладка настроек с кнопкой «Переиндексировать»
   * достижима (host `CROSS_CUTTING_SETTINGS_MODULES`), т.е. кнопка без бэкенда.
   * Привилегированность несёт `search:manage` (проверено выше), а не включённость.
   */
  it('ни один search-роут не гейтится @RequireModule (T-018, включая reindex)', () => {
    for (const handler of [
      CommonBffController.prototype.search,
      CommonBffController.prototype.searchClientSettings,
      CommonBffController.prototype.searchStatus,
      CommonBffController.prototype.reindex,
    ]) {
      expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, handler)).toBeUndefined();
    }
    expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, CommonBffController)).toBeUndefined();
  });
});

describe('[TODO-492] project search settings are applied by the gateway', () => {
  it('normalizeSearchSettings drops garbage and clamps ranges', () => {
    expect(normalizeSearchSettings({ minQueryChars: 3, perTypeLimit: 10 })).toMatchObject({
      minQueryChars: 3,
      perTypeLimit: 10,
    });
    expect(normalizeSearchSettings({ perTypeLimit: 5000 }).perTypeLimit).toBe(100);
    expect(normalizeSearchSettings({ minQueryChars: 0, perTypeLimit: -1 })).toEqual({
      minQueryChars: undefined,
      perTypeLimit: undefined,
      indexableTypes: undefined,
      freshnessSlaMs: undefined,
    });
    expect(normalizeSearchSettings({ indexableTypes: ['deal', 42, ''] }).indexableTypes).toEqual([
      'deal',
    ]);
    expect(normalizeSearchSettings(undefined)).toEqual({
      minQueryChars: undefined,
      perTypeLimit: undefined,
      indexableTypes: undefined,
      freshnessSlaMs: undefined,
    });
  });

  it('perTypeLimit from settings beats the FE default hint on the grouped overlay', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = build({ search: rpc }, controlWithSettings({ perTypeLimit: 9 }));

    await ctrl.search(req(), 'акме', 'p1', '0', '25', undefined, '5');

    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ per_type_limit: 9 }), {});
  });

  it('an explicit type filter keeps the client per-type limit (= page size)', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = build({ search: rpc }, controlWithSettings({ perTypeLimit: 9 }));

    await ctrl.search(req(), 'акме', 'p1', '1', '50', 'deal', '50');

    expect(rpc).toHaveBeenCalledWith(
      expect.objectContaining({ per_type_limit: 50, entity_types: ['deal'], page_index: 1 }),
      {},
    );
  });

  it('indexableTypes narrows the requested types', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = build(
      { search: rpc },
      controlWithSettings({ indexableTypes: ['deal', 'contact'] }),
    );

    await ctrl.search(req(), 'акме', 'p1', '0', '25', 'deal,order');

    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ entity_types: ['deal'] }), {});
  });

  it('indexableTypes becomes the type set when the caller asked for none', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = build(
      { search: rpc },
      controlWithSettings({ indexableTypes: ['deal', 'contact'] }),
    );

    await ctrl.search(req(), 'акме', 'p1');

    expect(rpc).toHaveBeenCalledWith(
      expect.objectContaining({ entity_types: ['deal', 'contact'] }),
      {},
    );
  });

  it('empty intersection returns an empty result instead of widening to ALL types', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = build({ search: rpc }, controlWithSettings({ indexableTypes: ['deal'] }));

    const res = await ctrl.search(req(), 'акме', 'p1', '0', '25', 'order');

    // Sending entity_types: [] downstream would mean "no restriction" in the domain.
    expect(rpc).not.toHaveBeenCalled();
    expect(res).toEqual({ groups: [], total: 0, total_by_type: {}, has_more: false });
  });

  it('minQueryChars from settings short-circuits below the threshold', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = build({ search: rpc }, controlWithSettings({ minQueryChars: 4 }));

    const short = await ctrl.search(req(), 'акм', 'p1');
    expect(rpc).not.toHaveBeenCalled();
    expect(short).toEqual({ groups: [], total: 0, total_by_type: {}, has_more: false });

    await ctrl.search(req(), 'акме', 'p1');
    expect(rpc).toHaveBeenCalledTimes(1);
    const call = rpc.mock.calls[0] as unknown as [Record<string, unknown>] | undefined;
    expect(call?.[0]).toMatchObject({ min_query_chars: 4 });
  });

  it('status() reports the project freshness SLA over the domain env default', async () => {
    const status = jest.fn(() => of({ lag_ms: 7000, freshness_sla_ms: 5000, indexed_count: 3 }));
    const ctrl = build({ status }, controlWithSettings({ freshnessSlaMs: 12000 }));

    const res = await ctrl.searchStatus(req());

    expect(res).toMatchObject({ lagMs: 7000, freshnessSlaMs: 12000, indexedCount: 3 });
  });

  it('status() falls back to the domain value when the project saved none', async () => {
    const status = jest.fn(() => of({ lag_ms: 1, freshness_sla_ms: 5000 }));
    const ctrl = build({ status }, controlWithSettings(null));

    expect((await ctrl.searchStatus(req())).freshnessSlaMs).toBe(5000);
  });

  it('a control outage degrades to module defaults, never to a failed search', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const control = stubClient({
      getProject: jest.fn(() => {
        throw new Error('control is down');
      }),
    });
    const ctrl = build({ search: rpc }, control);

    await expect(ctrl.search(req(), 'акме', 'p1')).resolves.toMatchObject({ total: 0 });
    expect(rpc).toHaveBeenCalledWith(
      expect.objectContaining({ entity_types: [], per_type_limit: 0 }),
      {},
    );
  });

  it('settings are cached per project (no control round-trip per keystroke)', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const control = controlWithSettings({ perTypeLimit: 7 });
    const getProject = (control.getService('') as { getProject: jest.Mock }).getProject;
    const ctrl = build({ search: rpc }, control);

    await ctrl.search(req(), 'акме', 'p1');
    await ctrl.search(req(), 'акмеа', 'p1');

    expect(getProject).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe('[TODO-492, tail] hotkeyEnabled reaches the client', () => {
  it('GET /search/settings is gated like /search/query (search:read, not manage)', () => {
    // Whoever may search may learn how the search box must behave; index
    // internals stay behind search:manage on /search/status.
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        CommonBffController.prototype.searchClientSettings,
      ),
    ).toEqual({ subject: 'search', action: 'read' });
  });

  it('delivers the saved hotkeyEnabled=false to an ordinary member', async () => {
    // The write path (SearchSettingsTab → control) already worked; nothing read
    // the value back, because the control GET is project:manage-gated.
    const ctrl = build({}, controlWithSettings({ hotkeyEnabled: false, minQueryChars: 3 }));

    await expect(ctrl.searchClientSettings(req())).resolves.toEqual({
      minQueryChars: 3,
      perTypeLimit: 5,
      hotkeyEnabled: false,
      indexableTypes: [],
    });
  });

  it('an unconfigured project answers with module defaults (hotkey on)', async () => {
    const ctrl = build({}, controlWithSettings(null));

    await expect(ctrl.searchClientSettings(req())).resolves.toEqual({
      minQueryChars: 2,
      perTypeLimit: 5,
      hotkeyEnabled: true,
      indexableTypes: [],
    });
  });

  it('a control outage degrades to defaults instead of failing the search shell', async () => {
    const ctrl = build(
      {},
      stubClient({
        getProject: jest.fn(() => {
          throw new Error('control is down');
        }),
      }),
    );

    await expect(ctrl.searchClientSettings(req())).resolves.toMatchObject({
      hotkeyEnabled: true,
      minQueryChars: 2,
    });
  });

  it('passes through the project type restriction and freshness SLA', async () => {
    const ctrl = build(
      {},
      controlWithSettings({ indexableTypes: ['deal', 'contact'], freshnessSlaMs: 12000 }),
    );

    await expect(ctrl.searchClientSettings(req())).resolves.toMatchObject({
      indexableTypes: ['deal', 'contact'],
      freshnessSlaMs: 12000,
    });
  });

  it('normalizeSearchSettings keeps hotkeyEnabled boolean-only', () => {
    // 'false' as a string must not be coerced to `true` — that would silently
    // re-enable a hotkey the admin turned off.
    expect(normalizeSearchSettings({ hotkeyEnabled: false }).hotkeyEnabled).toBe(false);
    expect(normalizeSearchSettings({ hotkeyEnabled: 'false' }).hotkeyEnabled).toBeUndefined();
    expect(normalizeSearchSettings({}).hotkeyEnabled).toBeUndefined();
  });

  it('resolves the project from the ambient header like the other search routes', async () => {
    const control = controlWithSettings({ hotkeyEnabled: false });
    const getProject = (control.getService('') as { getProject: jest.Mock }).getProject;
    const ctrl = build({}, control);

    await ctrl.searchClientSettings(req('p-hdr'));

    expect(getProject).toHaveBeenCalledWith({ id: 'p-hdr' }, {});
  });
});

describe('[TODO-281] reindex resolves the project like query/status', () => {
  it('uses the ambient x-project-id header when the query param is absent', async () => {
    const rpc = jest.fn(() => of({ indexed_count: 3, sources: ['deal'] }));
    const ctrl = build({ reindex: rpc });

    await ctrl.reindex(req('p-hdr'), '' as never);

    expect(rpc).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'p-hdr', entity_types: [] }),
      {},
    );
  });

  it('passes the domain reindex response through untouched (truncated/skipped_types)', async () => {
    const rpc = jest.fn(() =>
      of({ indexed_count: 7, sources: ['deal'], truncated: true, skipped_types: ['contact'] }),
    );
    const ctrl = build({ reindex: rpc });

    await expect(ctrl.reindex(req(), 'p1')).resolves.toMatchObject({
      indexed_count: 7,
      truncated: true,
      skipped_types: ['contact'],
    });
  });

  it('FR-SEARCH-325: appends search.reindexed to the audit journal (fail-soft)', async () => {
    const appendEvent = jest.fn(() => of({ id: 'ev-1' }));
    const rpc = jest.fn(() =>
      of({ indexed_count: 12, sources: ['contact'], truncated: false, skipped_types: [] }),
    );
    const ctrl = build({ reindex: rpc }, stubClient(), { appendEvent });

    await ctrl.reindex(req(), 'p1', 'contact,deal');

    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect((appendEvent.mock.calls[0] as unknown[])[0]).toMatchObject({
      project_id: 'p1',
      event_name: 'search.reindexed',
      entity_type: 'search',
      entity_id: 'p1',
    });
    const payload = JSON.parse(
      String((appendEvent.mock.calls[0] as unknown as [{ payload_json?: string }])[0].payload_json),
    );
    expect(payload).toMatchObject({
      entityTypes: ['contact', 'deal'],
      indexedCount: 12,
      truncated: false,
    });
  });
});

describe('[NFR-670] search query rate limit', () => {
  it('returns 429 when the per-user budget is exhausted', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = build({ search: rpc });
    const key = 'search:user:u1:p1';
    for (let i = 0; i < SEARCH_QUERY_RATE.maxRequests; i += 1) {
      gatewaySearchQueryRateLimiter.assertAllowed(
        key,
        SEARCH_QUERY_RATE.maxRequests,
        SEARCH_QUERY_RATE.windowMs,
      );
    }
    await expect(ctrl.search(req(), 'акме', 'p1')).rejects.toBeInstanceOf(HttpException);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('[TODO-491, gateway half] Idempotency-Key reaches the domain', () => {
  it('outbound metadata carries idempotency-key for POST /search/reindex', () => {
    const svc = new GatewayOutboundMetadataService({
      gatewayServiceApiKey: 'ak_test',
      gatewayApiKeyId: 'kid_test',
    } as never);

    const md = svc.build(
      {
        headers: { 'idempotency-key': 'ik-42', 'x-project-id': 'p1' },
        user: { userId: 'u1' },
      } as never,
      { projectId: 'p1' },
    );

    expect(md.get(GW_METADATA.IDEMPOTENCY_KEY)).toEqual(['ik-42']);
  });
});
