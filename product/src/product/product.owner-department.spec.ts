/**
 * TODO-293: `ownerDepartmentId` на создании продукта проверяется по реальному
 * составу подразделений проекта.
 *
 * До этого поле принималось как есть, а оно — OWNER_FIELD каталога
 * (`buildVisibilityFilter`): выдуманный id прячет продукт у всех, чей режим
 * видимости не `all`, и update его не переписывает (S6) — чинить только руками.
 */
import { status } from '@grpc/grpc-js';
import { ProductService } from './product.service';
import { DepartmentValidatorService } from '../control/department-validator.service';

function makeService(departments?: Partial<DepartmentValidatorService>) {
  const insertOne = jest.fn(async (_doc: Record<string, unknown>) => undefined);
  const mongo = {
    products: () => ({ insertOne, countDocuments: jest.fn(async () => 1) }),
  } as never;
  const outbox = {
    withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown }>) =>
      (await fn(undefined)).result,
  } as never;
  const svc = new ProductService(
    mongo,
    outbox,
    undefined,
    undefined,
    departments as DepartmentValidatorService | undefined,
  );
  return { svc, insertOne };
}

const payload = { name: 'Тариф', price: 100, owner_department_id: 'dept-1' };

describe('ProductService.create — гейт ownerDepartmentId (TODO-293)', () => {
  it('существующее подразделение проверяется и сохраняется', async () => {
    const assertOwnerDepartment = jest.fn(async () => undefined);
    const { svc, insertOne } = makeService({ assertOwnerDepartment });

    const row = await svc.create('p1', { ...payload });

    expect(assertOwnerDepartment).toHaveBeenCalledWith('p1', 'dept-1');
    expect(insertOne.mock.calls[0][0]).toMatchObject({ ownerDepartmentId: 'dept-1' });
    expect(row.owner_department_id).toBe('dept-1');
  });

  it('несуществующее подразделение — отказ ДО вставки', async () => {
    const { svc, insertOne } = makeService({
      assertOwnerDepartment: jest.fn(async () => {
        throw { code: status.INVALID_ARGUMENT, message: 'Указано недопустимое подразделение' };
      }),
    });

    await expect(
      svc.create('p1', { ...payload, owner_department_id: 'dept-999' }),
    ).rejects.toMatchObject({ message: 'Указано недопустимое подразделение' });
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('без подразделения (владение уровня проекта) гейт не зовётся', async () => {
    const assertOwnerDepartment = jest.fn(async () => undefined);
    const { svc, insertOne } = makeService({ assertOwnerDepartment });

    await svc.create('p1', { name: 'Тариф', price: 100 });

    // null — дефолт каталога: он не должен зависеть от доступности control.
    expect(assertOwnerDepartment).toHaveBeenCalledWith('p1', null);
    expect(insertOne.mock.calls[0][0]).toMatchObject({ ownerDepartmentId: null });
  });
});
