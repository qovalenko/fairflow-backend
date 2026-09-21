import { AppError } from '@fairflow/shared';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
}));

const mockedCompare = jest.mocked(bcrypt.compare);

describe('AuthService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
  };
  const jwtService = {
    sign: jest.fn(() => 'signed.jwt'),
  };

  function make(): AuthService {
    return new AuthService(prisma as never, jwtService as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.JWT_EXPIRE;
  });

  it('validateUser returns null for missing user or bad password', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(make().validateUser('alice', 'pw')).resolves.toBeNull();

    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      login: 'alice',
      email: 'a@t.test',
      name: 'Alice',
      password: 'hash',
    });
    mockedCompare.mockResolvedValue(false as never);
    await expect(make().validateUser('alice', 'bad')).resolves.toBeNull();
  });

  it('validateUser strips password hash on success', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      login: 'alice',
      email: 'a@t.test',
      name: 'Alice',
      password: 'hash',
    });
    mockedCompare.mockResolvedValue(true as never);
    await expect(make().validateUser('alice', 'pw')).resolves.toEqual({
      id: 'u1',
      login: 'alice',
      email: 'a@t.test',
      name: 'Alice',
    });
  });

  it('validateAndLogin throws AppError on invalid credentials', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(make().validateAndLogin('x', 'y')).rejects.toBeInstanceOf(AppError);
  });

  it('issueToken signs JWT with normalized email and configured expiry', () => {
    process.env.JWT_EXPIRE = '2h';
    const svc = make();
    const res = svc.issueToken({
      id: 'u1',
      login: 'alice',
      email: ' Alice@Example.com ',
      name: null,
    });
    expect(jwtService.sign).toHaveBeenCalledWith(
      { sub: 'u1', login: 'alice', email: 'alice@example.com' },
      { expiresIn: 7200 },
    );
    expect(res).toEqual({
      accessToken: 'signed.jwt',
      expiresIn: '2h',
      user: { id: 'u1', login: 'alice', email: ' Alice@Example.com ', name: null },
    });
  });

  it('me returns active user row or null', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      login: 'alice',
      email: 'a@t.test',
      name: null,
    });
    await expect(make().me('u1')).resolves.toEqual({
      id: 'u1',
      login: 'alice',
      email: 'a@t.test',
      name: null,
    });
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(make().me('missing')).resolves.toBeNull();
  });
});
