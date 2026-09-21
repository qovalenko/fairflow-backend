/**
 * TODO-160: массовое переназначение обязано проверить нового владельца.
 * `ownerId` — ключ видимости (`buildVisibilityFilter(scope,'ownerId',…)`), поэтому
 * переназначение на не-участника проекта прячет пачку контактов.
 */
import { Metadata } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { GW_METADATA } from '@fairflow/shared';
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

function inboundMetadata(): Metadata {
  const md = new Metadata();
  md.set(GW_METADATA.SERVICE_API_KEY, 'ak_test');
  md.set(GW_METADATA.GATEWAY_API_KEY_ID, 'key-1');
  md.set(GW_METADATA.USER_ID, 'user-1');
  md.set(GW_METADATA.PROJECT_ID, 'proj-1');
  // Не в списке проброса — не должен уехать в control.
  md.set(GW_METADATA.VISIBILITY_SCOPE, 'should-not-be-forwarded');
  return md;
}

describe('ReassignTargetValidator (TODO-160)', () => {
  it('участник проекта проходит', async () => {
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

  it('участник вне visibility субъекта отклоняется (FR-CONTACTS-275)', async () => {
    const { validator } = buildValidator([{ id: 'user-2' }, { id: 'user-3' }]);
    const scope = {
      mode: 'restricted' as const,
      level: 'only_own' as const,
      selfId: 'user-1',
      ownerIds: ['user-1'],
      sharedRecordIds: [],
    };
    await expect(
      validator.assertOwnerAssignable('proj-1', 'user-3', inboundMetadata(), 'newOwnerId', scope),
    ).rejects.toMatchObject({ errorCode: 'invalid', details: { field: 'newOwnerId' } });
  });

  it('неизвестное подразделение отклоняется', async () => {
    const listMembers = jest.fn(() => of({ list: [] }));
    const listDepartments = jest.fn(() => of({ list: [{ id: 'dept-1' }] }));
    const control = {
      getService: (name: string) =>
        name === 'ProjectGrpc' ? { listMembers } : { listDepartments },
    };
    const validator = new ReassignTargetValidator(control as never);
    await expect(
      validator.assertDepartmentAssignable('proj-1', 'dept-9', inboundMetadata()),
    ).rejects.toMatchObject({ errorCode: 'invalid', details: { field: 'newDepartmentId' } });
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

  it('в control уходит только проброшенная метадата gateway (ключ есть, scope нет)', async () => {
    const { validator, listMembers } = buildValidator([{ id: 'user-2' }]);
    await validator.assertOwnerAssignable('proj-1', 'user-2', inboundMetadata());
    const [req, md] = listMembers.mock.calls[0] as unknown as [{ project_id: string }, Metadata];
    expect(req).toEqual({ project_id: 'proj-1' });
    expect(md.get(GW_METADATA.SERVICE_API_KEY)[0]).toBe('ak_test');
    expect(md.get(GW_METADATA.USER_ID)[0]).toBe('user-1');
    expect(md.get(GW_METADATA.VISIBILITY_SCOPE)).toEqual([]);
  });

  it('control недоступен → отказ (fail-closed), а не пропуск проверки', async () => {
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
});
