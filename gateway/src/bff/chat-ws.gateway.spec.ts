import { bearerFromRequest } from './chat-ws.gateway';

describe('chat WS bearerFromRequest (TODO-285)', () => {
  it('rejects JWT in query string', () => {
    const req = {
      headers: {},
      query: { token: 'secret-jwt', projectId: 'p-1' },
      url: '/ws/chat?token=secret-jwt&projectId=p-1',
    };
    expect(bearerFromRequest(req as never)).toBeNull();
  });

  it('accepts Authorization Bearer', () => {
    const req = {
      headers: { authorization: 'Bearer hdr-token' },
      query: { token: 'query-must-not-win' },
    };
    expect(bearerFromRequest(req as never)).toBe('hdr-token');
  });

  it('accepts same-site cookie fallback', () => {
    const req = {
      headers: { cookie: 'ff_access_token=cookie-token; other=1' },
      query: {},
    };
    expect(bearerFromRequest(req as never)).toBe('cookie-token');
  });
});
