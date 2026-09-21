import { status as grpcStatus } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { DepartmentValidatorService } from './department-validator.service';

function makeService(list?: Array<{ id?: string }> | 'error') {
  const listDepartments = jest.fn(() => {
    if (list === 'error') return throwError(() => new Error('control down'));
    return of({ list: list ?? [{ id: 'dept-1' }, { id: 'dept-2' }] });
  });
  const client = { getService: jest.fn(() => ({ listDepartments })) };
  const svc = new DepartmentValidatorService(client as never);
  svc.onModuleInit();
  return { svc, listDepartments };
}

describe('DepartmentValidatorService', () => {
  it('short-circuits null/empty ownerDepartmentId without calling control', async () => {
    const { svc, listDepartments } = makeService();
    await expect(svc.assertOwnerDepartment('p1', null)).resolves.toBeUndefined();
    await expect(svc.assertOwnerDepartment('p1', '   ')).resolves.toBeUndefined();
    expect(listDepartments).not.toHaveBeenCalled();
  });

  it('accepts a department id returned by control', async () => {
    const { svc } = makeService([{ id: 'dept-1' }]);
    await expect(svc.assertOwnerDepartment('p1', 'dept-1')).resolves.toBeUndefined();
  });

  it('rejects unknown department ids with INVALID_ARGUMENT', async () => {
    const { svc } = makeService([{ id: 'dept-1' }]);
    await expect(svc.assertOwnerDepartment('p1', 'dept-999')).rejects.toMatchObject({
      error: expect.objectContaining({
        code: grpcStatus.INVALID_ARGUMENT,
        message: 'Указано недопустимое подразделение',
      }),
    });
  });

  it('fail-closes when control is unreachable', async () => {
    const { svc } = makeService('error');
    await expect(svc.assertOwnerDepartment('p1', 'dept-1')).rejects.toMatchObject({
      error: expect.objectContaining({
        code: grpcStatus.UNAVAILABLE,
        message: expect.stringContaining('control не отвечает'),
      }),
    });
  });

  it('caches department lists per project', async () => {
    const { svc, listDepartments } = makeService([{ id: 'dept-1' }]);
    await svc.assertOwnerDepartment('p1', 'dept-1');
    await svc.assertOwnerDepartment('p1', 'dept-1');
    expect(listDepartments).toHaveBeenCalledTimes(1);
  });

  it('обновляет кэш после истечения TTL', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const { svc, listDepartments } = makeService([{ id: 'dept-1' }]);

    await svc.assertOwnerDepartment('p1', 'dept-1');
    nowSpy.mockReturnValue(1_000_000 + 31_000);
    await svc.assertOwnerDepartment('p1', 'dept-1');

    expect(listDepartments).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('игнорирует подразделения с пустым id из control', async () => {
    const { svc } = makeService([{ id: '' }, { id: 'dept-1' }]);
    await expect(svc.assertOwnerDepartment('p1', 'dept-1')).resolves.toBeUndefined();
    await expect(svc.assertOwnerDepartment('p1', '')).resolves.toBeUndefined();
  });
});
