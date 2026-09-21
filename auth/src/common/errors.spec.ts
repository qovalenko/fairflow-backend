import { HttpStatus } from '@nestjs/common';
import { AppError, getHttpStatusFromErrorCode, InvalidDataError } from './errors';

describe('getHttpStatusFromErrorCode', () => {
  it.each([
    ['invalid', HttpStatus.BAD_REQUEST],
    ['notFound', HttpStatus.NOT_FOUND],
    ['internal', HttpStatus.INTERNAL_SERVER_ERROR],
    ['auth', HttpStatus.UNAUTHORIZED],
    ['access', HttpStatus.FORBIDDEN],
    ['rateLimit', HttpStatus.TOO_MANY_REQUESTS],
    ['invalid_client', HttpStatus.UNAUTHORIZED],
    ['invalid_grant', HttpStatus.BAD_REQUEST],
    ['unsupported_grant_type', HttpStatus.BAD_REQUEST],
  ] as const)('maps %s to HTTP %i', (code, status) => {
    expect(getHttpStatusFromErrorCode(code)).toBe(status);
  });
});

describe('AppError', () => {
  it('serializes errorCode, message and optional details', () => {
    const err = new AppError('access', 'forbidden', { resource: 'session' });
    expect(err.toJSON()).toEqual({
      errorCode: 'access',
      message: 'forbidden',
      details: { resource: 'session' },
    });
  });

  it('omits details key when not provided', () => {
    expect(new AppError('auth', 'nope').toJSON()).toEqual({
      errorCode: 'auth',
      message: 'nope',
    });
  });
});

describe('InvalidDataError', () => {
  it('includes field-level validation errors in JSON', () => {
    const err = new InvalidDataError('bad input', [{ field: 'email', message: 'required' }]);
    expect(err.toJSON()).toMatchObject({
      errorCode: 'invalid',
      message: 'bad input',
      errors: [{ field: 'email', message: 'required' }],
    });
  });
});
