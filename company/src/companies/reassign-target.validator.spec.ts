/**
 * FR-COMPANIES-300 / TODO-366: проверка цели переназначения владельца и подразделения.
 */
import { Metadata } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { GW_METADATA, type VisibilityScope } from '@fairflow/shared';
import { ReassignTargetValidator } from './reassign-target.validator';

function buildValidator(members: { id: string }[] | Error) {
  const listMembers = jest.fn(() =>
    members instanceof Error ? throwError(() => members) : of({ list: members }),
  );
  const control = { getService: () => ({ listMembers }) };
  return {
    validator: new ReassignTargetValidator(control as never),
    listMembers,
  };
}

function buildDepartmentValidator(
  departments: { id: string }[] | Error,
  members: { id: string }[] = [{ id: 'user-2' }],
) {
  const listMembers = jest.fn(() => of({ list: members }));
  const listDepartments = jest.fn(() =>
    departments instanceof Error ? throwError(() => departments) : of({ list: departments }),
  );
  const control = {
    getService: (name: string) => (name === 'ProjectGrpc' ? { listMembers } : { listDepartments }),
  };
  return {
    validator: new ReassignTargetValidator(control as never),
    listMembers,
    listDepartments,
  };
}

function inboundMetadata(): Metadata {
  const md = new Metadata();
  md.set(GW_METADATA.SERVICE_API_KEY, 'ak_test');
  md.set(GW_METADATA.GATEWAY_API_KEY_ID, 'key-1');
  md.set(GW_METADATA.USER_ID, 'user-1');
  md.set(GW_METADATA.PROJECT_ID, 'proj-1');
  md.set(GW_METADATA.VISIBILITY_SCOPE, 'should-not-be-forwarded');
  return md;
}

describe('FR-COMPANIES-300 ReassignTargetValidator', () => {
  it('assertOwnerVisibleToSubject отклоняет владельца вне scope актора', () => {
    const validator = new ReassignTargetValidator();
    const scope: VisibilityScope = {
      mode: 'restricted',
      level: 'only_own',
      selfId: 'user-1',
      ownerIds: ['user-1'],
      sharedRecordIds: [],
    };
    expect(() => validator.assertOwnerVisibleToSubject(scope, 'user-2')).toThrow(
      expect.objectContaining({ errorCode: 'invalid' }),
    );
  });

  it('assertOwnerVisibleToSubject пропускает владельца внутри scope', () => {
    const validator = new ReassignTargetValidator();
    const scope: VisibilityScope = {
      mode: 'restricted',
      level: 'only_own',
      selfId: 'user-1',
      ownerIds: ['user-1', 'user-2'],
      sharedRecordIds: [],
    };
    expect(() => validator.assertOwnerVisibleToSubject(scope, 'user-2')).not.toThrow();
  });

  it('участник проекта проходит assertOwnerAssignable', async () => {
    const { validator } = buildValidator([{ id: 'user-2' }, { id: 'user-3' }]);
    await expect(
      validator.assertOwnerAssignable('proj-1', 'user-2', inboundMetadata()),
    ).resolves.toBeUndefined();
  });

  it('не-участник отклоняется как недопустимый владелец', async () => {
    const { validator } = buildValidator([{ id: 'user-2' }]);
    await expect(
      validator.assertOwnerAssignable('proj-1', 'user-999', inboundMetadata()),
    ).rejects.toMatchObject({ errorCode: 'invalid', details: { field: 'newOwnerId' } });
  });

  it('участник вне visibility субъекта отклоняется', async () => {
    const { validator } = buildValidator([{ id: 'user-2' }, { id: 'user-3' }]);
    const scope: VisibilityScope = {
      mode: 'restricted',
      level: 'only_own',
      selfId: 'user-1',
      ownerIds: ['user-1'],
      sharedRecordIds: [],
    };
    await expect(
      validator.assertOwnerAssignable('proj-1', 'user-3', inboundMetadata(), 'newOwnerId', scope),
    ).rejects.toMatchObject({ errorCode: 'invalid', details: { field: 'newOwnerId' } });
  });

  it('пустой владелец отклоняется без похода в control', async () => {
    const { validator, listMembers } = buildValidator([{ id: 'user-2' }]);
    await expect(validator.assertOwnerAssignable('proj-1', '   ')).rejects.toMatchObject({
      errorCode: 'invalid',
    });
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('состав проекта запрашивается один раз на батч (кэш)', async () => {
    const { validator, listMembers } = buildValidator([{ id: 'user-2' }]);
    await validator.assertOwnerAssignable('proj-1', 'user-2', inboundMetadata());
    await validator.assertOwnerAssignable('proj-1', 'user-2', inboundMetadata());
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it('в control уходит только проброшенная метадата gateway', async () => {
    const { validator, listMembers } = buildValidator([{ id: 'user-2' }]);
    await validator.assertOwnerAssignable('proj-1', 'user-2', inboundMetadata());
    const [req, md] = listMembers.mock.calls[0] as unknown as [{ project_id: string }, Metadata];
    expect(req).toEqual({ project_id: 'proj-1' });
    expect(md.get(GW_METADATA.SERVICE_API_KEY)[0]).toBe('ak_test');
    expect(md.get(GW_METADATA.USER_ID)[0]).toBe('user-1');
    expect(md.get(GW_METADATA.VISIBILITY_SCOPE)).toEqual([]);
  });

  it('control недоступен → отказ (fail-closed)', async () => {
    const { validator } = buildValidator(new Error('UNAVAILABLE'));
    await expect(
      validator.assertOwnerAssignable('proj-1', 'user-2', inboundMetadata()),
    ).rejects.toMatchObject({ errorCode: 'internal' });
  });

  it('клиента control нет вовсе → тоже отказ', async () => {
    const validator = new ReassignTargetValidator();
    await expect(validator.assertOwnerAssignable('proj-1', 'user-2')).rejects.toMatchObject({
      errorCode: 'internal',
    });
  });

  it('известное подразделение проходит assertDepartmentAssignable', async () => {
    const { validator } = buildDepartmentValidator([{ id: 'dept-1' }]);
    await expect(
      validator.assertDepartmentAssignable('proj-1', 'dept-1', inboundMetadata()),
    ).resolves.toBeUndefined();
  });

  it('неизвестное подразделение отклоняется', async () => {
    const { validator } = buildDepartmentValidator([{ id: 'dept-1' }]);
    await expect(
      validator.assertDepartmentAssignable('proj-1', 'dept-9', inboundMetadata()),
    ).rejects.toMatchObject({ errorCode: 'invalid', details: { field: 'newDepartmentId' } });
  });

  it('пустое подразделение отклоняется без похода в control', async () => {
    const { validator, listDepartments } = buildDepartmentValidator([{ id: 'dept-1' }]);
    await expect(validator.assertDepartmentAssignable('proj-1', '  ')).rejects.toMatchObject({
      errorCode: 'invalid',
    });
    expect(listDepartments).not.toHaveBeenCalled();
  });

  it('список подразделений кэшируется на батч', async () => {
    const { validator, listDepartments } = buildDepartmentValidator([{ id: 'dept-1' }]);
    await validator.assertDepartmentAssignable('proj-1', 'dept-1', inboundMetadata());
    await validator.assertDepartmentAssignable('proj-1', 'dept-1', inboundMetadata());
    expect(listDepartments).toHaveBeenCalledTimes(1);
  });

  it('OrganizationGrpc недоступен → отказ проверки подразделения', async () => {
    const listMembers = jest.fn(() => of({ list: [{ id: 'user-2' }] }));
    const control = {
      getService: (name: string) => {
        if (name === 'ProjectGrpc') return { listMembers };
        throw new Error('OrganizationGrpc missing');
      },
    };
    const validator = new ReassignTargetValidator(control as never);
    await expect(
      validator.assertDepartmentAssignable('proj-1', 'dept-1', inboundMetadata()),
    ).rejects.toMatchObject({ errorCode: 'internal' });
  });

  it('ошибка listDepartments → internal', async () => {
    const { validator } = buildDepartmentValidator(new Error('timeout'));
    await expect(
      validator.assertDepartmentAssignable('proj-1', 'dept-1', inboundMetadata()),
    ).rejects.toMatchObject({ errorCode: 'internal' });
  });
});
