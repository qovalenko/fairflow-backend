import { of, throwError } from 'rxjs';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { BootstrapStateService } from './bootstrap-state.service';

jest.mock('../bff/grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('BootstrapStateService', () => {
  function make(authList: unknown, hasSystem: unknown) {
    const authGrpc = { listUsers: jest.fn(() => authList) };
    const orgGrpc = { hasSystem: jest.fn(() => hasSystem) };
    const authClient = { getService: jest.fn(() => authGrpc) };
    const controlClient = { getService: jest.fn(() => orgGrpc) };
    const outboundMeta = { build: jest.fn(() => ({})) };
    const svc = new BootstrapStateService(
      authClient as never,
      controlClient as never,
      outboundMeta as never,
    );
    svc.onModuleInit();
    return svc;
  }

  beforeEach(() => {
    mockedGrpcBffCall.mockImplementation(async (obs) => {
      const { firstValueFrom } = await import('rxjs');
      return firstValueFrom(obs as never);
    });
  });

  it('returns unknown when auth is unreachable and never probed (FR-AUTH-023)', async () => {
    const svc = make(
      throwError(() => new Error('down')),
      of({ exists: false }),
    );
    await expect(svc.probe({ headers: {} } as never)).resolves.toBe('unknown');
  });

  it('returns not-initialized when auth answers with zero users', async () => {
    const svc = make(of({ list: [], total: 0 }), of({ exists: false }));
    await expect(svc.probe({ headers: {} } as never)).resolves.toBe('not-initialized');
  });

  it('latches initialized after first positive probe without re-querying auth', async () => {
    const svc = make(of({ list: [{ id: 'u1' }], total: 1 }), of({ exists: true }));
    await expect(svc.probe({ headers: {} } as never)).resolves.toBe('initialized');
    mockedGrpcBffCall.mockClear();
    await expect(svc.probe({ headers: {} } as never)).resolves.toBe('initialized');
    expect(mockedGrpcBffCall).not.toHaveBeenCalled();
  });

  it('markInitialized sets both user and system latches', async () => {
    const svc = make(of({ list: [] }), of({ exists: false }));
    svc.markInitialized();
    await expect(svc.probe({ headers: {} } as never)).resolves.toBe('initialized');
    await expect(svc.hasSystem({ headers: {} } as never)).resolves.toBe(true);
  });

  it('returns cached not-initialized within TTL without re-querying auth', async () => {
    const svc = make(of({ list: [], total: 0 }), of({ exists: false }));
    await expect(svc.probe({ headers: {} } as never)).resolves.toBe('not-initialized');
    mockedGrpcBffCall.mockClear();
    await expect(svc.probe({ headers: {} } as never)).resolves.toBe('not-initialized');
    expect(mockedGrpcBffCall).not.toHaveBeenCalled();
  });

  it('isInitialized returns false on auth outage when never probed', async () => {
    const svc = make(
      throwError(() => new Error('down')),
      of({ exists: false }),
    );
    await expect(svc.isInitialized({ headers: {} } as never)).resolves.toBe(false);
  });

  it('hasSystem resolves control HasSystem and caches positive answer', async () => {
    const svc = make(of({ list: [{ id: 'u1' }], total: 1 }), of({ exists: true }));
    await expect(svc.hasSystem({ headers: {} } as never)).resolves.toBe(true);
    mockedGrpcBffCall.mockClear();
    await expect(svc.hasSystem({ headers: {} } as never)).resolves.toBe(true);
    expect(mockedGrpcBffCall).not.toHaveBeenCalled();
  });

  it('markUserExists prevents duplicate registration race during org bootstrap', async () => {
    const svc = make(of({ list: [], total: 0 }), of({ exists: false }));
    svc.markUserExists();
    await expect(svc.probe({ headers: {} } as never)).resolves.toBe('initialized');
  });
});
