/**
 * ProductGrpcController — делегирование в сервисы, decode prefill Struct, metadata projectId.
 */
import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { ProductGrpcController } from './product.grpc.controller';

describe('ProductGrpcController', () => {
  const product = {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    archive: jest.fn(),
    restore: jest.fn(),
    delete: jest.fn(),
    usage: jest.fn(),
    listCategories: jest.fn(),
  };
  const usageSvc = { recount: jest.fn() };
  const idempotency = {
    withIdempotency: jest.fn(
      async (_p: string, _k: string | undefined, _op: string, exec: () => Promise<unknown>) =>
        exec(),
    ),
  };
  const ctrl = new ProductGrpcController(product as never, usageSvc as never, idempotency as never);

  beforeEach(() => jest.clearAllMocks());

  it('ListProducts берёт projectId из metadata и прокидывает query', async () => {
    product.list.mockResolvedValue({ list: [], total: 0 });
    const md = new Metadata();
    md.set('x-project-id', 'trusted-p');

    await ctrl.list({ page_index: 1, page_size: 10, query: 'x' }, md);

    expect(product.list).toHaveBeenCalledWith(
      'trusted-p',
      1,
      10,
      expect.objectContaining({ query: 'x' }),
    );
  });

  it('CreateProduct декодирует proto Struct prefill и вызывает idempotency', async () => {
    product.create.mockResolvedValue({ id: 'prod-1' });
    const md = new Metadata();
    md.set('x-project-id', 'p1');
    md.set('idempotency-key', 'idem-1');
    md.set('x-user-id', 'u1');

    await ctrl.create(
      {
        name: 'Plan',
        prefill: { fields: { seats: { numberValue: 5 }, note: { stringValue: 'hi' } } },
      },
      md,
    );

    expect(idempotency.withIdempotency).toHaveBeenCalledWith(
      'p1',
      'idem-1',
      'create',
      expect.any(Function),
      expect.any(Function),
    );
    expect(product.create).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ prefill: { seats: 5, note: 'hi' } }),
      'u1',
    );
  });

  it('отклоняет конфликт projectId в body и metadata', () => {
    const md = new Metadata();
    md.set('x-project-id', 'trusted-p');

    expect(() => ctrl.get({ project_id: 'other-p', id: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, md)).toThrow(
      RpcException,
    );
    expect(product.get).not.toHaveBeenCalled();
  });

  it('RecountProductUsage делегирует в UsageService', async () => {
    usageSvc.recount.mockResolvedValue({ recounted: 2, skipped: 1 });
    const md = new Metadata();
    md.set('x-project-id', 'p1');

    const res = await ctrl.recountUsage({ id: 'prod-1' }, md);

    expect(usageSvc.recount).toHaveBeenCalledWith('p1', 'prod-1');
    expect(res).toEqual({ recounted: 2, skipped: 1 });
  });

  it('GetProduct делегирует в ProductService с metadata scope', async () => {
    product.get.mockResolvedValue({ id: 'prod-1' });
    const md = new Metadata();
    md.set('x-project-id', 'p1');

    await ctrl.get({ id: 'prod-1' }, md);

    expect(product.get).toHaveBeenCalledWith('p1', 'prod-1', undefined, { present: false });
  });

  it('UpdateProduct декодирует prefill Struct', async () => {
    product.update.mockResolvedValue({ id: 'prod-1' });
    const md = new Metadata();
    md.set('x-project-id', 'p1');
    md.set('x-user-id', 'u1');

    await ctrl.update(
      {
        id: 'prod-1',
        prefill: { fields: { qty: { numberValue: 3 } } },
      },
      md,
    );

    expect(product.update).toHaveBeenCalledWith(
      'p1',
      'prod-1',
      expect.objectContaining({ prefill: { qty: 3 } }),
      'u1',
      expect.anything(),
    );
  });

  it('ArchiveProduct и RestoreProduct прокидывают userId', async () => {
    product.archive.mockResolvedValue({ id: 'prod-1' });
    product.restore.mockResolvedValue({ id: 'prod-1' });
    const md = new Metadata();
    md.set('x-project-id', 'p1');
    md.set('x-user-id', 'u1');

    await ctrl.archive({ id: 'prod-1' }, md);
    await ctrl.restore({ id: 'prod-1' }, md);

    expect(product.archive).toHaveBeenCalledWith('p1', 'prod-1', 'u1', expect.anything());
    expect(product.restore).toHaveBeenCalledWith('p1', 'prod-1', 'u1', expect.anything());
  });

  it('DeleteProduct передаёт force и userId', async () => {
    product.delete.mockResolvedValue({ deleted: true });
    const md = new Metadata();
    md.set('x-project-id', 'p1');
    md.set('x-user-id', 'u1');

    await ctrl.delete({ id: 'prod-1', force: true }, md);

    expect(product.delete).toHaveBeenCalledWith('p1', 'prod-1', true, 'u1', expect.anything());
  });

  it('GetProductUsage и ListCategories делегируют в ProductService', async () => {
    product.usage.mockResolvedValue({ dealsCount: 1 });
    product.listCategories.mockResolvedValue(['cat-a']);
    const md = new Metadata();
    md.set('x-project-id', 'p1');

    await ctrl.usage({ id: 'prod-1', department_id: 'dep-1' }, md);
    await ctrl.listCategories({}, md);

    expect(product.usage).toHaveBeenCalledWith('p1', 'prod-1', 'dep-1', undefined, {
      present: false,
    });
    expect(product.listCategories).toHaveBeenCalledWith('p1', undefined, { present: false });
  });

  it('берёт projectId из body, когда metadata отсутствует (s2s fallback)', async () => {
    product.get.mockResolvedValue({ id: 'prod-1' });

    await ctrl.get({ project_id: 'body-p', id: 'prod-1' });

    expect(product.get).toHaveBeenCalledWith('body-p', 'prod-1', undefined, { present: false });
  });

  it('ListProducts прокидывает camelCase projectId из body при отсутствии metadata', async () => {
    product.list.mockResolvedValue({ list: [], total: 0 });

    await ctrl.list({ projectId: 'camel-p', page_index: 0, page_size: 10 });

    expect(product.list).toHaveBeenCalledWith(
      'camel-p',
      0,
      10,
      expect.objectContaining({ scope: undefined, access: { present: false } }),
    );
  });
});
