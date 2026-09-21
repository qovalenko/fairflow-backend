import {
  assertChatIntegrationRateLimit,
  assertChatTypingAllowed,
  chatIntegrationRateLimiter,
  chatTypingRateLimiter,
  chatWsConnectionRegistry,
  CHAT_INTEGRATION_RATE,
} from './chat-rate-limit';

describe('chat-rate-limit', () => {
  beforeEach(() => {
    chatTypingRateLimiter.reset();
    chatIntegrationRateLimiter.reset();
    chatWsConnectionRegistry.reset();
  });

  it('throttles typing to one signal per window per conversation', () => {
    assertChatTypingAllowed('u1', 'c1');
    expect(() => assertChatTypingAllowed('u1', 'c1')).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    assertChatTypingAllowed('u1', 'c2');
  });

  it('limits integration sends per user/project window', () => {
    for (let i = 0; i < CHAT_INTEGRATION_RATE.maxRequests; i++) {
      assertChatIntegrationRateLimit('bot', 'p1');
    }
    expect(() => assertChatIntegrationRateLimit('bot', 'p1')).toThrow(
      expect.objectContaining({ status: 429 }),
    );
  });

  it('caps WS connections per user', () => {
    const max = parseInt(process.env.CHAT_WS_MAX_CONN_PER_USER ?? '5', 10);
    for (let i = 0; i < max; i++) {
      expect(chatWsConnectionRegistry.tryAcquire('u1')).toBe(true);
    }
    expect(chatWsConnectionRegistry.tryAcquire('u1')).toBe(false);
    chatWsConnectionRegistry.release('u1');
    expect(chatWsConnectionRegistry.tryAcquire('u1')).toBe(true);
  });
});
