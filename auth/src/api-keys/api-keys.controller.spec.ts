import { ApiKeysController } from './api-keys.controller';
import { AppError } from '../common/errors';

describe('ApiKeysController.introspect', () => {
  const makeController = (validate: jest.Mock) => new ApiKeysController({ validate } as never);

  it('throws auth AppError when neither X-API-Key nor Bearer token is present', async () => {
    const validate = jest.fn();
    const c = makeController(validate);
    await expect(c.introspect(undefined, undefined)).rejects.toMatchObject({
      errorCode: 'auth',
      message: 'Missing X-API-Key or Authorization: Bearer',
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it('prefers X-API-Key over Authorization header', async () => {
    const validate = jest.fn().mockResolvedValue({
      clientId: 'gw',
      scopes: ['gateway:invoke'],
    });
    const c = makeController(validate);
    const res = await c.introspect('ak_header', 'Bearer ak_bearer');
    expect(validate).toHaveBeenCalledWith('ak_header');
    expect(res).toEqual({ active: true, client_id: 'gw', scopes: ['gateway:invoke'] });
  });

  it('extracts Bearer ak_ token when X-API-Key is absent', async () => {
    const validate = jest.fn().mockResolvedValue({
      clientId: 'svc',
      scopes: ['x'],
    });
    const c = makeController(validate);
    const res = await c.introspect(undefined, 'Bearer ak_from_bearer');
    expect(validate).toHaveBeenCalledWith('ak_from_bearer');
    expect(res).toEqual({ active: true, client_id: 'svc', scopes: ['x'] });
  });

  it('returns { active: false } for an invalid/revoked key without throwing', async () => {
    const validate = jest.fn().mockResolvedValue(null);
    const c = makeController(validate);
    await expect(c.introspect('ak_bad', undefined)).resolves.toEqual({ active: false });
  });

  it('does not treat a non-Bearer Authorization header as an API key', async () => {
    const validate = jest.fn();
    const c = makeController(validate);
    await expect(c.introspect(undefined, 'Basic dXNlcjpwdw==')).rejects.toBeInstanceOf(AppError);
    expect(validate).not.toHaveBeenCalled();
  });
});
