/**
 * [be-p0-notify-prefs] `/notification/preferences` category round-trip.
 *
 * `CategoryPref` is a `repeated` message in proto/domain, but the FE
 * `NotificationPreferences.categories` is a `Record<category, CategoryPref>`
 * (NotificationSettings.tsx builds and indexes a map). The BFF only handled the
 * array form, so:
 *  - PUT: the FE map failed `Array.isArray` → `categories` was dropped before the
 *    gRPC call and per-category channel toggles were NEVER persisted, silently;
 *  - GET: the domain array reached the FE as an array → `prefs.categories[cat]`
 *    was always undefined and saved toggles never rendered.
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CommonBffController } from './common-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

const domainPrefs = {
  user_id: 'u1',
  email_mode: 'daily',
  digest_time: '09:00',
  timezone: 'Europe/Moscow',
  categories: [
    { category: 'deals', in_app: true, email: false, escalate_offline: false },
    { category: 'activities', in_app: true, email: true, escalate_offline: true },
  ],
  quiet_hours: { from: '22:00', to: '08:00', tz: 'Europe/Moscow' },
  updated_at: 1786788000000,
};

describe('[be-p0-notify-prefs] notification preferences mapping', () => {
  function build(notification: Record<string, unknown>) {
    const ctrl = new CommonBffController(
      stubClient(notification),
      stubClient(),
      stubClient(),
      stubClient(),
      { build: () => ({}) } as never,
      { publishBadge: jest.fn(), subscribe: jest.fn() } as never,
    );
    ctrl.onModuleInit();
    return ctrl;
  }

  const req = { user: { userId: 'u1' }, headers: {} } as never;

  it('GET: domain array → FE record map keyed by category', async () => {
    const ctrl = build({ getPreferences: jest.fn(() => of(domainPrefs)) });

    const res = (await ctrl.getPreferences(req)) as {
      categories: Record<string, { in_app: boolean; email: boolean }>;
      email_mode: string;
      quiet_hours: unknown;
    };

    expect(Array.isArray(res.categories)).toBe(false);
    expect(res.categories.deals).toEqual({ in_app: true, email: false, escalate_offline: false });
    expect(res.categories.activities).toEqual({
      in_app: true,
      email: true,
      escalate_offline: true,
    });
    expect(res.email_mode).toBe('daily');
    expect(res.quiet_hours).toEqual({ from: '22:00', to: '08:00', tz: 'Europe/Moscow' });
  });

  it('PUT: the FE record map reaches the domain as repeated CategoryPref', async () => {
    const rpc = jest.fn((_r: unknown, _m?: unknown) => of(domainPrefs));
    const ctrl = build({ updatePreferences: rpc });

    await ctrl.updatePreferences(req, {
      email_mode: 'daily',
      digest_time: '09:00',
      timezone: 'Europe/Moscow',
      categories: {
        deals: { in_app: true, email: false },
        activities: { in_app: true, email: true, escalate_offline: true },
      },
    });

    const sent = rpc.mock.calls[0][0] as unknown as { categories: Record<string, unknown>[] };
    expect(sent.categories).toEqual([
      { category: 'deals', in_app: true, email: false, escalate_offline: false },
      { category: 'activities', in_app: true, email: true, escalate_offline: true },
    ]);
  });

  it('PUT: a legacy array body still works (no regression)', async () => {
    const rpc = jest.fn((_r: unknown, _m?: unknown) => of(domainPrefs));
    const ctrl = build({ updatePreferences: rpc });

    await ctrl.updatePreferences(req, {
      categories: [{ category: 'deals', inApp: false, email: true }],
    });

    const sent = rpc.mock.calls[0][0] as unknown as { categories: Record<string, unknown>[] };
    expect(sent.categories).toEqual([
      { category: 'deals', in_app: false, email: true, escalate_offline: false },
    ]);
  });

  it('PUT: an absent categories field stays undefined (partial update preserved)', async () => {
    const rpc = jest.fn((_r: unknown, _m?: unknown) => of(domainPrefs));
    const ctrl = build({ updatePreferences: rpc });

    await ctrl.updatePreferences(req, { email_mode: 'off' });

    const sent = rpc.mock.calls[0][0] as unknown as { categories?: unknown };
    expect(sent.categories).toBeUndefined();
  });

  it('GET: BOX default email_mode is off when domain has no explicit mode', async () => {
    const prev = process.env.FAIRFLOW_EDITION;
    process.env.FAIRFLOW_EDITION = 'box';
    try {
      const ctrl = build({
        getPreferences: jest.fn(() =>
          of({
            user_id: 'u1',
            categories: [],
            digest_time: '',
            timezone: '',
            updated_at: 0,
          }),
        ),
      });

      const res = (await ctrl.getPreferences(req)) as { email_mode: string };
      expect(res.email_mode).toBe('off');
    } finally {
      if (prev === undefined) delete process.env.FAIRFLOW_EDITION;
      else process.env.FAIRFLOW_EDITION = prev;
    }
  });

  it('PUT: the echo uses the same FE shape as the GET (SWR cache write-back)', async () => {
    const ctrl = build({ updatePreferences: jest.fn(() => of(domainPrefs)) });

    const res = (await ctrl.updatePreferences(req, { email_mode: 'daily' })) as {
      categories: Record<string, unknown>;
    };

    expect(res.categories.deals).toBeDefined();
  });
});
