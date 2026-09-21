/**
 * [be-p0-notify-envelope] gateway BFF for `/notification/*`.
 *
 * Restores the end-to-end path domain → gateway → FE:
 *  - `GET /notification/list` must answer `{ list, total }` (contract §3.2 /
 *    `NotificationListResponse`). It used to answer a BARE ARRAY, so
 *    `useNotifications` (`listData?.list ?? []`) rendered an always-empty bell.
 *  - `notificationFe` must carry the typed fields the domain already fills
 *    (`toMessage`): category / severity / eventType / entityType / entityId /
 *    emailStatus / projectId / channels / readAt / sentAt.
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CommonBffController } from './common-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

const CREATED_AT = Date.UTC(2026, 7, 15, 10, 0, 0);
const SENT_AT = CREATED_AT + 1000;
const READ_AT = CREATED_AT + 2000;

/** Exactly the shape `notification.service.ts#toMessage` returns (keepCase: true). */
const domainRow = {
  id: 'n1',
  project_id: 'p1',
  user_id: 'u1',
  channel: 'in_app',
  title: 'Сделка просрочена',
  body: 'Сделка №12 без активности 5 дней',
  data_json: JSON.stringify({ path: '/deals/d1', category_title: 'Сделки' }),
  status: 'sent',
  readed: false,
  email_to: '',
  created_at: CREATED_AT,
  sent_at: SENT_AT,
  read_at: READ_AT,
  category: 'deals',
  event_type: 'deal.stalled',
  severity: 'important',
  channels: ['in_app', 'email'],
  entity_type: 'deal',
  entity_id: 'd1',
  email_status: 'sent',
};

describe('[be-p0-notify-envelope] CommonBffController notification mapping', () => {
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

  it('nList returns { list, total } — not a bare array (FE NotificationListResponse)', async () => {
    const ctrl = build({
      listNotifications: jest.fn(() => of({ list: [domainRow], total: 42 })),
    });

    const res = (await ctrl.nList(req, 'p1')) as {
      list: Record<string, unknown>[];
      total: number;
    };

    expect(Array.isArray(res)).toBe(false);
    expect(res.total).toBe(42);
    expect(res.list).toHaveLength(1);
    expect(res.list[0].id).toBe('n1');
  });

  it('coerces a Long-like total and survives an absent list', async () => {
    const ctrl = build({
      listNotifications: jest.fn(() => of({ total: { low: 7, high: 0, unsigned: false } })),
    });

    const res = (await ctrl.nList(req, 'p1')) as { list: unknown[]; total: number };

    expect(res.list).toEqual([]);
    expect(res.total).toBe(7);
  });

  it('every field the domain fills survives the FE mapping (nothing dropped)', async () => {
    const ctrl = build({
      listNotifications: jest.fn(() => of({ list: [domainRow], total: 1 })),
    });

    const res = (await ctrl.nList(req, 'p1')) as { list: Record<string, unknown>[] };
    const fe = res.list[0];

    expect(fe).toMatchObject({
      id: 'n1',
      target: 'Сделка просрочена',
      description: 'Сделка №12 без активности 5 дней',
      status: 'sent',
      readed: false,
      location: '/deals/d1',
      locationLabel: 'Сделки',
      // restored by [be-p0]
      category: 'deals',
      severity: 'important',
      eventType: 'deal.stalled',
      entityType: 'deal',
      entityId: 'd1',
      emailStatus: 'sent',
      projectId: 'p1',
      channels: ['in_app', 'email'],
    });
    expect(fe.date).toBe(new Date(CREATED_AT).toISOString());
    expect(fe.sentAt).toBe(new Date(SENT_AT).toISOString());
    expect(fe.readAt).toBe(new Date(READ_AT).toISOString());
  });

  it('absent optional fields degrade to safe defaults (proto3 omits empties)', async () => {
    const ctrl = build({
      listNotifications: jest.fn(() =>
        of({ list: [{ id: 'n2', title: 't', created_at: CREATED_AT }], total: 1 }),
      ),
    });

    const res = (await ctrl.nList(req, 'p1')) as { list: Record<string, unknown>[] };
    const fe = res.list[0];

    expect(fe).toMatchObject({
      category: '',
      severity: 'info',
      entityType: '',
      channels: [],
      readAt: null,
      sentAt: null,
    });
  });

  it('reads the domain deep-link key `deepLink` into location (chat notifications)', async () => {
    const ctrl = build({
      listNotifications: jest.fn(() =>
        of({
          list: [
            {
              id: 'n3',
              created_at: CREATED_AT,
              data_json: JSON.stringify({ deepLink: '/chat/c1?seq=7', isMention: true }),
            },
          ],
          total: 1,
        }),
      ),
    });

    const res = (await ctrl.nList(req, 'p1')) as { list: Record<string, unknown>[] };

    expect(res.list[0].location).toBe('/chat/c1?seq=7');
  });

  it('markRead echoes the same enriched FE shape', async () => {
    const ctrl = build({ markRead: jest.fn(() => of({ ...domainRow, readed: true })) });

    const fe = (await ctrl.markRead(req, 'n1', 'p1')) as Record<string, unknown>;

    expect(fe).toMatchObject({ readed: true, category: 'deals', severity: 'important' });
  });

  it('sendNotification forwards category + Idempotency-Key and never passes body emailTo', async () => {
    const send = jest.fn(() => of(domainRow));
    const ctrl = build({ send });
    const sendReq = {
      user: { userId: 'svc' },
      headers: { 'idempotency-key': 'idem-send-1', 'x-project-id': 'p1' },
    } as never;

    await ctrl.sendNotification(
      sendReq,
      {
        userId: 'u1',
        title: 't',
        body: 'b',
        category: 'deals',
        emailTo: 'attacker@evil.test',
      },
      'p1',
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'p1',
        user_id: 'u1',
        category: 'deals',
        idempotency_key: 'idem-send-1',
        email_to: '',
      }),
      expect.anything(),
    );
  });
});
