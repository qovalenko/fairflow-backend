import { LocalStrategy } from './local.strategy';
import type { AuthService } from '../auth.service';

describe('LocalStrategy', () => {
  const make = (validateUser: jest.Mock) =>
    new LocalStrategy({ validateUser } as unknown as AuthService);

  it('returns null when identifier is blank', async () => {
    const validateUser = jest.fn();
    const strategy = make(validateUser);
    const user = await strategy.validate({ body: { email: '   ' } }, '', 'secret');
    expect(user).toBeNull();
    expect(validateUser).not.toHaveBeenCalled();
  });

  it('prefers body.email over passport username field', async () => {
    const validateUser = jest.fn().mockResolvedValue({ id: 'u1' });
    const strategy = make(validateUser);
    const user = await strategy.validate(
      { body: { email: '  alice@corp.test  ' } },
      'ignored',
      'pw',
    );
    expect(user).toEqual({ id: 'u1' });
    expect(validateUser).toHaveBeenCalledWith('alice@corp.test', 'pw');
  });

  it('falls back to body.login when email is absent', async () => {
    const validateUser = jest.fn().mockResolvedValue({ id: 'u2' });
    const strategy = make(validateUser);
    await strategy.validate({ body: { login: 'bob' } }, 'ignored', 'pw');
    expect(validateUser).toHaveBeenCalledWith('bob', 'pw');
  });

  it('returns null when credentials do not validate', async () => {
    const validateUser = jest.fn().mockResolvedValue(null);
    const strategy = make(validateUser);
    await expect(
      strategy.validate({ body: { email: 'x@y.z' } }, 'x@y.z', 'bad'),
    ).resolves.toBeNull();
  });
});
