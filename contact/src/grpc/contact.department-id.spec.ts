/**
 * W-6 (department scoping v1): `CreateContact.department_id` доезжает до домена
 * и проходит тот же гейт, что и `ReassignContacts.new_department_id`.
 *
 * Без гейта контакт можно было создать на несуществующее подразделение: тогда он
 * сразу пропадал из выдачи у всех, у кого режим видимости не `all`
 * (departmentId — ключ `buildOwnableVisibilityFilter`).
 */
import { Metadata } from '@grpc/grpc-js';
import { ContactGrpcController } from './contact.grpc.controller';

type Svc = Record<string, jest.Mock>;

function buildController(reassignOverrides: Record<string, jest.Mock> = {}): {
  ctl: ContactGrpcController;
  contacts: Svc;
  md: Metadata;
  reassignTargets: Record<string, jest.Mock>;
} {
  const contacts: Svc = {
    create: jest.fn(async () => ({ id: 'c1' })),
  };
  const idempotency = {
    withIdempotency: (_p: string, _k: unknown, _op: string, fn: () => unknown) => fn(),
  };
  const reassignTargets: Record<string, jest.Mock> = {
    assertOwnerAssignable: jest.fn(async () => undefined),
    assertDepartmentAssignable: jest.fn(async () => undefined),
    ...reassignOverrides,
  };
  const ctl = new ContactGrpcController(
    contacts as never,
    idempotency as never,
    reassignTargets as never,
  );
  const md = new Metadata();
  md.set('x-project-id', 'p1');
  md.set('x-user-id', 'user-1');
  return { ctl, contacts, md, reassignTargets };
}

describe('CreateContact: department_id (W-6)', () => {
  it('валидное подразделение проверяется и записывается в документ', async () => {
    const { ctl, contacts, md, reassignTargets } = buildController();

    await ctl.createContact(
      { first_name: 'Иван', last_name: 'Иванов', email: 'a@b.ru', department_id: 'dept-1' },
      md,
    );

    expect(reassignTargets.assertDepartmentAssignable).toHaveBeenCalledWith(
      'p1',
      'dept-1',
      md,
      'departmentId',
    );
    expect(contacts.create.mock.calls[0][1]).toMatchObject({ departmentId: 'dept-1' });
  });

  it('пустое поле — не «подразделение не найдено», а «фильтр не задан»', async () => {
    const { ctl, contacts, md, reassignTargets } = buildController();

    await ctl.createContact(
      { first_name: 'Иван', last_name: 'Иванов', email: 'a@b.ru', department_id: '  ' },
      md,
    );

    expect(reassignTargets.assertDepartmentAssignable).not.toHaveBeenCalled();
    expect(contacts.create.mock.calls[0][1]).not.toHaveProperty('departmentId');
  });

  it('чужое/несуществующее подразделение — отказ ДО записи и до идемпотентности', async () => {
    const { ctl, contacts, md } = buildController({
      assertDepartmentAssignable: jest.fn(async () => {
        throw new Error('Указано недопустимое подразделение');
      }),
    });

    await expect(
      ctl.createContact(
        { first_name: 'Иван', last_name: 'Иванов', email: 'a@b.ru', department_id: 'dept-999' },
        md,
      ),
    ).rejects.toThrow('Указано недопустимое подразделение');
    expect(contacts.create).not.toHaveBeenCalled();
  });
});
