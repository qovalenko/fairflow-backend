import { Metadata, status as grpcStatus } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { OrderSourceReaderService } from './order-source-reader.service';

function grpcClient(service: Record<string, jest.Mock>) {
  return { getService: () => service } as never;
}

function makeReader(services: {
  contact?: Record<string, jest.Mock>;
  company?: Record<string, jest.Mock>;
  pipe?: Record<string, jest.Mock>;
  product?: Record<string, jest.Mock>;
}) {
  const reader = new OrderSourceReaderService(
    grpcClient(services.contact ?? { getContact: jest.fn() }),
    grpcClient(services.company ?? { getCompany: jest.fn() }),
    grpcClient(services.pipe ?? { getDeal: jest.fn() }),
    grpcClient(services.product ?? { getProduct: jest.fn() }),
  );
  reader.onModuleInit();
  return reader;
}

describe('OrderSourceReaderService', () => {
  beforeAll(() => {
    process.env.ORDERS_SERVICE_API_KEY = 'ak_test';
  });

  describe('readContact', () => {
    it('returns present fields when the donor answers', async () => {
      const getContact = jest.fn().mockReturnValue(
        of({
          first_name: 'Ivan',
          middle_name: 'Ivanovich',
          last_name: 'Petrov',
          phone: ' +7 ',
          email: ' a@b.c ',
        }),
      );
      const reader = makeReader({ contact: { getContact } });
      const out = await reader.readContact('p1', 'c1');
      expect(out).toEqual({
        state: 'present',
        fields: { name: 'Ivan Ivanovich Petrov', phone: '+7', email: 'a@b.c' },
      });
      expect(getContact).toHaveBeenCalledWith({ project_id: 'p1', id: 'c1' }, expect.any(Metadata));
    });

    it('returns deleted on gRPC NOT_FOUND', async () => {
      const getContact = jest
        .fn()
        .mockReturnValue(
          throwError(() => Object.assign(new Error('nf'), { code: grpcStatus.NOT_FOUND })),
        );
      const reader = makeReader({ contact: { getContact } });
      expect(await reader.readContact('p1', 'c1')).toEqual({ state: 'deleted', fields: {} });
    });

    it('returns unknown on donor timeout / transport failure', async () => {
      const getContact = jest.fn().mockReturnValue(throwError(() => new Error('timeout')));
      const reader = makeReader({ contact: { getContact } });
      expect(await reader.readContact('p1', 'c1')).toEqual({ state: 'unknown', fields: {} });
    });

    it('returns unknown without calling gRPC when projectId or id is empty', async () => {
      const getContact = jest.fn();
      const reader = makeReader({ contact: { getContact } });
      expect(await reader.readContact('', 'c1')).toEqual({ state: 'unknown', fields: {} });
      expect(await reader.readContact('p1', '')).toEqual({ state: 'unknown', fields: {} });
      expect(getContact).not.toHaveBeenCalled();
    });
  });

  describe('readCompany', () => {
    it('returns present company requisites', async () => {
      const getCompany = jest
        .fn()
        .mockReturnValue(of({ name: ' Acme ', inn: ' 7701 ', kpp: ' 770101 ' }));
      const reader = makeReader({ company: { getCompany } });
      expect(await reader.readCompany('p1', 'co1')).toEqual({
        state: 'present',
        fields: { name: 'Acme', inn: '7701', kpp: '770101' },
      });
    });

    it('returns deleted on NOT_FOUND', async () => {
      const getCompany = jest
        .fn()
        .mockReturnValue(
          throwError(() => Object.assign(new Error('nf'), { code: grpcStatus.NOT_FOUND })),
        );
      const reader = makeReader({ company: { getCompany } });
      expect(await reader.readCompany('p1', 'co1')).toEqual({ state: 'deleted', fields: {} });
    });
  });

  describe('readDealName', () => {
    it('returns trimmed deal name', async () => {
      const getDeal = jest.fn().mockReturnValue(of({ name: ' Big deal ' }));
      const reader = makeReader({ pipe: { getDeal } });
      expect(await reader.readDealName('p1', 'd1')).toBe('Big deal');
    });

    it('returns empty string on NOT_FOUND or transport failure (fail-soft)', async () => {
      const getDeal = jest.fn().mockReturnValue(throwError(() => new Error('down')));
      const reader = makeReader({ pipe: { getDeal } });
      expect(await reader.readDealName('p1', 'd1')).toBe('');
    });

    it('returns empty string when projectId or id is missing', async () => {
      const getDeal = jest.fn();
      const reader = makeReader({ pipe: { getDeal } });
      expect(await reader.readDealName('', 'd1')).toBe('');
      expect(getDeal).not.toHaveBeenCalled();
    });
  });

  describe('readProductForOrder', () => {
    it('maps catalog fields and struct prefill', async () => {
      const getProduct = jest.fn().mockReturnValue(
        of({
          name: ' Widget ',
          order_type_id: ' ot1 ',
          order_type_dangling: true,
          effective_price: 99.5,
          currency: ' RUB ',
          unit: ' pcs ',
          category: ' cat ',
          prefill: {
            fields: {
              color: { stringValue: 'red' },
              qty: { numberValue: 2 },
              gift: { boolValue: true },
            },
          },
        }),
      );
      const reader = makeReader({ product: { getProduct } });
      expect(await reader.readProductForOrder('p1', 'pr1')).toEqual({
        orderTypeId: 'ot1',
        dangling: true,
        name: 'Widget',
        price: 99.5,
        currency: 'RUB',
        unit: 'pcs',
        category: 'cat',
        prefill: { color: 'red', qty: 2, gift: true },
      });
    });

    it('returns null when the product is gone (NOT_FOUND)', async () => {
      const getProduct = jest
        .fn()
        .mockReturnValue(
          throwError(() => Object.assign(new Error('nf'), { code: grpcStatus.NOT_FOUND })),
        );
      const reader = makeReader({ product: { getProduct } });
      expect(await reader.readProductForOrder('p1', 'pr1')).toBeNull();
    });

    it('fail-soft returns null on transport failure', async () => {
      const getProduct = jest.fn().mockReturnValue(throwError(() => new Error('down')));
      const reader = makeReader({ product: { getProduct } });
      expect(await reader.readProductForOrder('p1', 'pr1')).toBeNull();
    });

    it('rethrows when failSoft=false', async () => {
      const getProduct = jest.fn().mockReturnValue(throwError(() => new Error('down')));
      const reader = makeReader({ product: { getProduct } });
      await expect(reader.readProductForOrder('p1', 'pr1', { failSoft: false })).rejects.toThrow(
        'down',
      );
    });
  });

  describe('readProductSaleType', () => {
    it('returns orderTypeId and dangling flag from the product read', async () => {
      const getProduct = jest
        .fn()
        .mockReturnValue(of({ order_type_id: 'ot9', order_type_dangling: false, name: 'X' }));
      const reader = makeReader({ product: { getProduct } });
      expect(await reader.readProductSaleType('p1', 'pr1')).toEqual({
        orderTypeId: 'ot9',
        dangling: false,
      });
    });

    it('returns null when the product read returns null', async () => {
      const getProduct = jest
        .fn()
        .mockReturnValue(
          throwError(() => Object.assign(new Error('nf'), { code: grpcStatus.NOT_FOUND })),
        );
      const reader = makeReader({ product: { getProduct } });
      expect(await reader.readProductSaleType('p1', 'pr1')).toBeNull();
    });
  });
});
