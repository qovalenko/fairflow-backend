import { UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { of, throwError, type Observable } from 'rxjs';
import { createHash } from 'node:crypto';
import { ProjectApiKeyGuard, type ApiKeyRequest } from './project-api-key.guard';

type ValidateResult = {
  valid?: boolean;
  project_id?: string;
  key_id?: string;
  name?: string;
  status?: string;
};

function ctxWith(headers: Record<string, unknown>, req?: Partial<ApiKeyRequest>) {
  const request: ApiKeyRequest = { headers, ...req };
  return {
    switchToHttp: () => ({ getRequest: <T>() => request as unknown as T }),
    request,
  } as unknown as ExecutionContext & { request: ApiKeyRequest };
}

function makeGuard(validate: (arg: { key_hash: string }) => Observable<ValidateResult>) {
  const control = {
    getService: () => ({ validateProjectApiKey: (arg: { key_hash: string }) => validate(arg) }),
  };
  const outboundMeta = { build: () => ({}) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ProjectApiKeyGuard(control as any, outboundMeta as any);
}

describe('ProjectApiKeyGuard (BX-INTEG-2, fail-closed)', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  it('401 when no key is presented', async () => {
    const guard = makeGuard(() => of({ valid: true }));
    await expect(guard.canActivate(ctxWith({}))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401 for a malformed (non-ffk_) key WITHOUT hitting control', async () => {
    const validate = jest.fn(() => of<ValidateResult>({ valid: true }));
    const guard = makeGuard(validate);
    await expect(
      guard.canActivate(ctxWith({ authorization: 'Bearer sk_live_abc' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(validate).not.toHaveBeenCalled();
  });

  it('401 when control reports the key invalid (unknown/revoked)', async () => {
    const guard = makeGuard(() => of<ValidateResult>({ valid: false }));
    await expect(
      guard.canActivate(ctxWith({ 'x-api-key': 'ffk_deadbeef' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401 when control is unavailable (never fail-open)', async () => {
    const guard = makeGuard(() => throwError(() => new Error('control down')));
    await expect(
      guard.canActivate(ctxWith({ authorization: 'Bearer ffk_deadbeef' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401 when valid but no projectId resolved (no leak → deny)', async () => {
    const guard = makeGuard(() => of<ValidateResult>({ valid: true, project_id: '' }));
    await expect(
      guard.canActivate(ctxWith({ authorization: 'Bearer ffk_deadbeef' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('hashes the presented key and attaches a read-only project-scoped principal', async () => {
    const plaintext = 'ffk_0123456789abcdef';
    const seen: string[] = [];
    const guard = makeGuard(({ key_hash }) => {
      seen.push(key_hash);
      return of<ValidateResult>({
        valid: true,
        project_id: 'proj-1',
        key_id: 'key-1',
        name: 'Zapier',
        status: 'active',
      });
    });
    const ctx = ctxWith({ authorization: `Bearer ${plaintext}` });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // sha-256 of the plaintext (never the plaintext itself) is what control receives.
    expect(seen).toEqual([sha(plaintext)]);
    expect(ctx.request.apiKeyPrincipal).toEqual({
      kind: 'api-key',
      projectId: 'proj-1',
      keyId: 'key-1',
      name: 'Zapier',
      scopes: ['records:read'],
    });
  });

  it('accepts the key via X-Api-Key header too', async () => {
    const guard = makeGuard(() =>
      of<ValidateResult>({
        valid: true,
        project_id: 'proj-2',
        key_id: 'k2',
        name: 'n',
        status: 'active',
      }),
    );
    const ctx = ctxWith({ 'x-api-key': 'ffk_abcabcabc' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(ctx.request.apiKeyPrincipal?.projectId).toBe('proj-2');
  });
});
