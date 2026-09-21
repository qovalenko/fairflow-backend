import { GatewayEventsService } from './gateway-events.service';

describe('GatewayEventsService.accessDenied (FR-ACCESS-630)', () => {
  it('publishes control.access.denied with actor, project and reason', async () => {
    const svc = new GatewayEventsService();
    const publish = jest.fn();
    (svc as unknown as { publish: typeof publish }).publish = publish;

    await svc.accessDenied({
      userId: 'user-1',
      projectId: 'proj-1',
      requestId: 'rid-1',
      method: 'GET',
      path: '/api/v1/deals',
      code: 'MODULE_POLICY_DENIED',
      message: 'denied',
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control.access.denied',
        source: 'control',
        projectId: 'proj-1',
        userId: 'user-1',
        actorType: 'user',
        payload: expect.objectContaining({
          code: 'MODULE_POLICY_DENIED',
          message: 'denied',
          method: 'GET',
          path: '/api/v1/deals',
          requestId: 'rid-1',
        }),
      }),
    );
  });

  it('uses service actor when user id is absent', async () => {
    const svc = new GatewayEventsService();
    const publish = jest.fn();
    (svc as unknown as { publish: typeof publish }).publish = publish;

    await svc.accessDenied({
      requestId: 'rid-2',
      code: 'FORBIDDEN',
      message: 'no user',
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'service',
        subject: 'access/denied',
      }),
    );
  });
});

describe('GatewayEventsService auth facts', () => {
  function svcWithPublish() {
    const svc = new GatewayEventsService();
    const publish = jest.fn();
    (svc as unknown as { publish: typeof publish }).publish = publish;
    return { svc, publish };
  }

  it('authLogin publishes gateway.auth.login with method and ip', async () => {
    const { svc, publish } = svcWithPublish();

    await svc.authLogin('u-1', { method: 'oidc', ip: '1.2.3.4' });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gateway.auth.login',
        userId: 'u-1',
        payload: expect.objectContaining({
          userId: 'u-1',
          method: 'oidc',
          ip: '1.2.3.4',
        }),
      }),
    );
  });

  it('authLogout publishes gateway.auth.logout with session id', async () => {
    const { svc, publish } = svcWithPublish();

    await svc.authLogout('u-1', 'sess-1');

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gateway.auth.logout',
        userId: 'u-1',
        payload: expect.objectContaining({ userId: 'u-1', sessionId: 'sess-1' }),
      }),
    );
  });

  it('authLoginFailed publishes gateway.auth.login_failed with identifier subject', async () => {
    const { svc, publish } = svcWithPublish();

    await svc.authLoginFailed({ identifier: 'alice@t.test', ip: '9.9.9.9' });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gateway.auth.login_failed',
        subject: 'user/alice@t.test',
        payload: expect.objectContaining({
          identifier: 'alice@t.test',
          ip: '9.9.9.9',
          method: 'password',
        }),
      }),
    );
  });
});

describe('GatewayEventsService broker seam', () => {
  const originalEnabled = process.env.GATEWAY_EVENTS_ENABLED;

  afterEach(() => {
    process.env.GATEWAY_EVENTS_ENABLED = originalEnabled;
  });

  it('skips publish when events are disabled', async () => {
    process.env.GATEWAY_EVENTS_ENABLED = 'false';
    const svc = new GatewayEventsService();
    const getChannel = (svc as unknown as { getChannel: () => Promise<unknown> }).getChannel.bind(
      svc,
    );

    await expect(svc.authLogin('u-1', { method: 'password' })).resolves.toBeUndefined();
    await expect(getChannel()).resolves.toBeNull();
  });

  it('closes broker handles on module destroy', async () => {
    const svc = new GatewayEventsService();
    const channel = { close: jest.fn().mockResolvedValue(undefined) };
    const connection = { close: jest.fn().mockResolvedValue(undefined) };
    (svc as unknown as { channel: unknown; connection: unknown }).channel = channel;
    (svc as unknown as { channel: unknown; connection: unknown }).connection = connection;

    await svc.onModuleDestroy();

    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it('publishes auth facts when the broker channel is available', async () => {
    const publish = jest.fn();
    const channel = {
      publish,
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new GatewayEventsService();
    (svc as unknown as { channel: typeof channel }).channel = channel;

    await svc.authLogin('u-1', { method: 'password', ip: '127.0.0.1' });

    expect(publish).toHaveBeenCalledWith(
      expect.any(String),
      'gateway.auth.login',
      expect.any(Buffer),
      expect.objectContaining({ persistent: true, contentType: 'application/json' }),
    );
  });
});
