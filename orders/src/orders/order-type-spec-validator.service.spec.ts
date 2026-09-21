import { RpcException } from '@nestjs/microservices';
import { status as grpcStatus } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { OrderTypeSpecValidatorService } from './order-type-spec-validator.service';

function grpcNotFound(message: string) {
  return Object.assign(new Error(message), { code: grpcStatus.NOT_FOUND });
}

function makeValidator(opts: {
  getConnection?: jest.Mock;
  getTemplate?: jest.Mock;
  listMembers?: jest.Mock;
}) {
  const automationClient = {
    getService: () => ({
      getConnection: opts.getConnection ?? jest.fn(() => of({ id: 'c1' })),
    }),
  };
  const documentsClient = {
    getService: () => ({
      getTemplate: opts.getTemplate ?? jest.fn(() => of({ id: 't1' })),
    }),
  };
  const controlClient = {
    getService: () => ({
      listMembers: opts.listMembers ?? jest.fn(() => of({ list: [{ id: 'u1' }] })),
    }),
  };
  const svc = new OrderTypeSpecValidatorService(
    automationClient as never,
    documentsClient as never,
    controlClient as never,
  );
  svc.onModuleInit();
  return svc;
}

function rpcError(err: unknown): { code?: number; message?: string } {
  expect(err).toBeInstanceOf(RpcException);
  return (err as RpcException).getError() as { code?: number; message?: string };
}

const okSpec = {
  fields: [],
  stages: [{ id: 's1', name: 'Done', order: 0, isTerminal: true }],
};

describe('OrderTypeSpecValidatorService (FR-ORDERS-035 / FR-ORDERS-100)', () => {
  it('accepts webhook when GetConnection succeeds', async () => {
    const getConnection = jest.fn(() => of({ id: 'conn-1' }));
    const svc = makeValidator({ getConnection });
    await expect(
      svc.assertValid('p1', {
        ...okSpec,
        finalActionSpec: { type: 'webhook', config: { connection_id: 'conn-1' } },
      }),
    ).resolves.toBeUndefined();
    expect(getConnection).toHaveBeenCalledWith(
      { project_id: 'p1', connection_id: 'conn-1' },
      expect.anything(),
    );
  });

  it('rejects missing webhook connection with a client-safe message', async () => {
    const svc = makeValidator({
      getConnection: jest.fn(() => throwError(() => grpcNotFound('Connection not found'))),
    });
    try {
      await svc.assertValid('p1', {
        ...okSpec,
        finalActionSpec: { type: 'webhook', config: { connection_id: 'gone' } },
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = rpcError(err);
      expect(e.code).toBe(grpcStatus.INVALID_ARGUMENT);
      expect(e.message).toBe('Подключение webhook не найдено в проекте');
    }
  });

  it('fail-closes webhook check when automation is down', async () => {
    const svc = makeValidator({
      getConnection: jest.fn(() => throwError(() => new Error('ECONNREFUSED'))),
    });
    try {
      await svc.assertValid('p1', {
        ...okSpec,
        finalActionSpec: { type: 'webhook', config: { connection_id: 'c1' } },
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = rpcError(err);
      expect(e.code).toBe(grpcStatus.UNAVAILABLE);
      expect(String(e.message)).toMatch(/automation/);
    }
  });

  it('rejects task assignee who is not a project member', async () => {
    const svc = makeValidator({
      listMembers: jest.fn(() => of({ list: [{ id: 'u-other' }] })),
    });
    try {
      await svc.assertValid('p1', {
        ...okSpec,
        finalActionSpec: { type: 'task', config: { title: 'Позвонить', userId: 'u1' } },
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = rpcError(err);
      expect(e.code).toBe(grpcStatus.INVALID_ARGUMENT);
      expect(e.message).toBe('Исполнитель задачи не является участником проекта');
    }
  });

  it('accepts task without assignee (executor falls back to order owner)', async () => {
    const listMembers = jest.fn(() => of({ list: [] }));
    const svc = makeValidator({ listMembers });
    await expect(
      svc.assertValid('p1', {
        ...okSpec,
        finalActionSpec: { type: 'task', config: { title: 'Позвонить' } },
      }),
    ).resolves.toBeUndefined();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('rejects unknown document template id', async () => {
    const svc = makeValidator({
      getTemplate: jest.fn(() => throwError(() => grpcNotFound('Шаблон не найден'))),
    });
    try {
      await svc.assertValid('p1', {
        ...okSpec,
        documentTemplates: [{ id: 'dead' }],
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = rpcError(err);
      expect(e.code).toBe(grpcStatus.INVALID_ARGUMENT);
      expect(e.message).toBe('Шаблон документа не найден в реестре');
    }
  });

  it('fail-closes template check when documents is down', async () => {
    const svc = makeValidator({
      getTemplate: jest.fn(() => throwError(() => new Error('UNAVAILABLE'))),
    });
    try {
      await svc.assertValid('p1', {
        ...okSpec,
        documentTemplates: [{ templateId: 't1' }],
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = rpcError(err);
      expect(e.code).toBe(grpcStatus.UNAVAILABLE);
      expect(String(e.message)).toMatch(/documents/);
    }
  });
});
