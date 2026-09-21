import { of, throwError } from 'rxjs';
import { status as grpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { CompanyRefValidator } from './company-ref.validator';

describe('CompanyRefValidator (FR-CONTACTS-310)', () => {
  it('пропускает пустой список', async () => {
    const v = new CompanyRefValidator();
    await expect(v.assertCompaniesExist('p1', [])).resolves.toBeUndefined();
  });

  it('отклоняет недоступность peer как internal', async () => {
    const getCompany = jest.fn(() =>
      throwError(() => Object.assign(new Error('unavailable'), { code: grpcStatus.UNAVAILABLE })),
    );
    const v = new CompanyRefValidator({ getService: () => ({ getCompany }) } as never);
    v.onModuleInit();
    await expect(v.assertCompaniesExist('p1', ['co-1'])).rejects.toMatchObject({
      errorCode: 'internal',
    });
  });

  it('отклоняет несуществующую компанию', async () => {
    const getCompany = jest.fn(() =>
      throwError(() => Object.assign(new Error('nf'), { code: grpcStatus.NOT_FOUND })),
    );
    const v = new CompanyRefValidator({ getService: () => ({ getCompany }) } as never);
    v.onModuleInit();
    try {
      await v.assertCompaniesExist('p1', ['missing']);
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      expect((err as RpcException).getError()).toMatchObject({
        code: grpcStatus.INVALID_ARGUMENT,
        message: 'Указана несуществующая компания',
      });
    }
  });

  it('peer INTERNAL при getCompany тоже отклоняется как invalid ref', async () => {
    const getCompany = jest.fn(() =>
      throwError(() => Object.assign(new Error('internal'), { code: grpcStatus.INTERNAL })),
    );
    const v = new CompanyRefValidator({ getService: () => ({ getCompany }) } as never);
    v.onModuleInit();
    try {
      await v.assertCompaniesExist('p1', ['missing']);
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      expect((err as RpcException).getError()).toMatchObject({
        code: grpcStatus.INVALID_ARGUMENT,
      });
    }
  });

  it('принимает существующую компанию', async () => {
    const getCompany = jest.fn(() => of({ id: 'co-1' }));
    const v = new CompanyRefValidator({ getService: () => ({ getCompany }) } as never);
    v.onModuleInit();
    await expect(v.assertCompaniesExist('p1', ['co-1'])).resolves.toBeUndefined();
  });
});
