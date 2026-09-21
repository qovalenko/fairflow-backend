import { of } from 'rxjs';
import { SnakeCaseResponseInterceptor } from './snake-case.interceptor';

describe('SnakeCaseResponseInterceptor', () => {
  const interceptor = new SnakeCaseResponseInterceptor();

  it('конвертирует camelCase ключи ответа в snake_case', async () => {
    const data = await new Promise<unknown>((resolve) => {
      interceptor
        .intercept({} as never, {
          handle: () =>
            of({
              senderId: 'u1',
              lastMessageAt: 100,
              nested: { myRole: 'owner', unreadCount: 2 },
              members: [{ userId: 'u2', joinedAt: 1 }],
            }),
        })
        .subscribe(resolve);
    });
    expect(data).toEqual({
      sender_id: 'u1',
      last_message_at: 100,
      nested: { my_role: 'owner', unread_count: 2 },
      members: [{ user_id: 'u2', joined_at: 1 }],
    });
  });

  it('не трогает примитивы и Date', async () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const data = await new Promise<unknown>((resolve) => {
      interceptor.intercept({} as never, { handle: () => of({ at: d, n: 1, s: 'x' }) }).subscribe(resolve);
    });
    expect(data).toEqual({ at: d, n: 1, s: 'x' });
  });
});
