import { MemberOwnedRecordsService } from './member-owned-records.service';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { of } from 'rxjs';

describe('MemberOwnedRecordsService (FR-PROJ-215)', () => {
  function makeSvc(contactCount: number, companyCount: number) {
    const contactGrpc = {
      countMemberOwnedRecords: jest.fn(() => of({ count: contactCount })),
      reassignMemberOwnedRecords: jest.fn(() => of({ reassigned: 0 })),
    };
    const companyGrpc = {
      countMemberOwnedRecords: jest.fn(() => of({ count: companyCount })),
      reassignMemberOwnedRecords: jest.fn(() => of({ reassigned: 0 })),
    };
    const emptyClient = {
      getService: jest.fn(() => ({
        countMemberOwnedRecords: jest.fn(() => of({ count: 0 })),
        reassignMemberOwnedRecords: jest.fn(() => of({ reassigned: 0 })),
      })),
    };
    const contactClient = {
      getService: jest.fn(() => contactGrpc),
    } as unknown as ClientGrpcProxy;
    const companyClient = {
      getService: jest.fn(() => companyGrpc),
    } as unknown as ClientGrpcProxy;
    const svc = new MemberOwnedRecordsService(
      contactClient,
      companyClient,
      emptyClient as unknown as ClientGrpcProxy,
      emptyClient as unknown as ClientGrpcProxy,
      emptyClient as unknown as ClientGrpcProxy,
      emptyClient as unknown as ClientGrpcProxy,
    );
    svc.onModuleInit();
    return { svc, contactGrpc, companyGrpc };
  }

  it('aggregates owned counts across enabled modules', async () => {
    const { svc } = makeSvc(2, 3);
    const r = await svc.countOwned('p1', 'u1', ['contacts', 'companies']);
    expect(r.total).toBe(5);
    expect(r.breakdown).toEqual([
      { domain: 'contacts', count: 2 },
      { domain: 'companies', count: 3 },
    ]);
  });

  it('still counts a domain whose module is currently disabled (data persists)', async () => {
    const { svc, companyGrpc } = makeSvc(5, 1);
    const r = await svc.countOwned('p1', 'u1', ['contacts']);
    expect(r.total).toBe(6);
    expect(companyGrpc.countMemberOwnedRecords).toHaveBeenCalled();
  });

  it('fail-closes when a domain count call fails', async () => {
    const { svc, companyGrpc } = makeSvc(1, 0);
    companyGrpc.countMemberOwnedRecords.mockImplementation(() => {
      throw new Error('unavailable');
    });
    await expect(svc.countOwned('p1', 'u1', ['contacts', 'companies'])).rejects.toMatchObject({
      errorCode: 'internal',
      details: { reason: 'OWNED_RECORDS_CHECK_FAILED', domain: 'companies' },
    });
  });
});
