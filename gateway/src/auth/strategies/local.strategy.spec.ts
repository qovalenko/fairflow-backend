jest.mock('../auth.service', () => ({
  AuthService: jest.fn(),
}));

import { LocalStrategy } from './local.strategy';

describe('LocalStrategy', () => {
  const authService = {
    validateUser: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the user when credentials are valid', async () => {
    const user = { id: 'u-1', login: 'alice' };
    authService.validateUser.mockResolvedValue(user);
    const strategy = new LocalStrategy(authService as never);

    await expect(strategy.validate('alice', 'secret')).resolves.toBe(user);
    expect(authService.validateUser).toHaveBeenCalledWith('alice', 'secret');
  });

  it('returns null when credentials are invalid', async () => {
    authService.validateUser.mockResolvedValue(null);
    const strategy = new LocalStrategy(authService as never);

    await expect(strategy.validate('alice', 'bad')).resolves.toBeNull();
  });
});
