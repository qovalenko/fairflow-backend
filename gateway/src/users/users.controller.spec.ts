import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController.list', () => {
  it('parses query params and delegates to UsersService', async () => {
    const users = {
      findMany: jest.fn().mockResolvedValue({ list: [], total: 0 }),
    };
    const ctrl = new UsersController(users as unknown as UsersService);
    const req = { headers: {}, user: { userId: 'admin' } };
    await ctrl.list(req as never, '10', '50', 'bob', 'false');
    expect(users.findMany).toHaveBeenCalledWith(req, {
      skip: 10,
      take: 50,
      login: 'bob',
      isActive: false,
    });
  });

  it('uses defaults for missing pagination and isActive filter', async () => {
    const users = { findMany: jest.fn().mockResolvedValue({ list: [], total: 0 }) };
    const ctrl = new UsersController(users as unknown as UsersService);
    await ctrl.list({ headers: {} } as never);
    expect(users.findMany).toHaveBeenCalledWith(expect.anything(), {
      skip: 0,
      take: 25,
      login: undefined,
      isActive: undefined,
    });
  });
});
