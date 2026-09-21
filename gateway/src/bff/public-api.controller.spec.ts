import { of } from 'rxjs';
import { grpcBffCall } from './grpc-bff-call';
import { PublicApiController } from './public-api.controller';

jest.mock('./grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('PublicApiController', () => {
  const outboundMeta = { buildForApiKey: jest.fn(() => ({})) };
  const listContacts = jest.fn(() =>
    of({
      list: [
        {
          id: 'c1',
          first_name: 'Ann',
          last_name: 'Bee',
          email: 'a@test',
          phone: '+1',
          company_ids: ['co1'],
          created_at: '2024-01-01',
          updated_at: '2024-01-02',
        },
      ],
      total: 1,
    }),
  );
  const listDeals = jest.fn(() =>
    of({
      list: [
        {
          id: 'd1',
          name: 'Deal',
          amount: 100,
          currency: 'USD',
          stage_id: 's1',
          stage_name: 'New',
          status: 'open',
          contact_id: 'c1',
          company_id: '',
          created_at: '2024-01-01',
          updated_at: '2024-01-02',
        },
      ],
      total: 1,
    }),
  );

  function make(): PublicApiController {
    const contactClient = { getService: jest.fn(() => ({ listContacts })) };
    const pipeClient = { getService: jest.fn(() => ({ listDeals })) };
    return new PublicApiController(
      contactClient as never,
      pipeClient as never,
      outboundMeta as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGrpcBffCall.mockImplementation(async (obs) => {
      const { firstValueFrom } = await import('rxjs');
      return firstValueFrom(obs as never);
    });
  });

  it('lists contacts scoped to the API key project with curated projection', async () => {
    const ctrl = make();
    const req = { apiKeyPrincipal: { projectId: 'proj-1' }, headers: {} };
    const res = await ctrl.listContacts(req as never, '1', '200', 'ann');
    expect(outboundMeta.buildForApiKey).toHaveBeenCalledWith(req, { projectId: 'proj-1' });
    expect(listContacts).toHaveBeenCalledWith(
      { project_id: 'proj-1', page_index: 1, page_size: 100, query: 'ann' },
      {},
    );
    expect(res.list[0]).toEqual({
      id: 'c1',
      firstName: 'Ann',
      lastName: 'Bee',
      email: 'a@test',
      phone: '+1',
      companyId: 'co1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-02',
    });
  });

  it('lists deals with clamped paging defaults', async () => {
    const ctrl = make();
    const req = { apiKeyPrincipal: { projectId: 'proj-1' }, headers: {} };
    const res = await ctrl.listDeals(req as never);
    expect(listDeals).toHaveBeenCalledWith(
      { project_id: 'proj-1', page_index: 0, page_size: 25, query: '' },
      {},
    );
    expect(res.list[0].stageName).toBe('New');
    expect(res.total).toBe(1);
  });
});
