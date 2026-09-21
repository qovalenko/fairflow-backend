import { RpcException } from '@nestjs/microservices';
import { ActivityService } from './activity.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService } from './project-members.service';

describe('FR-ACTIVITIES-040 type profile forbidden fields', () => {
  const svc = new ActivityService(
    {} as MongoService,
    {} as MongoOutboxStore,
    {} as NameResolverService,
    {
      assertAssigneeMember: jest.fn(),
      resolveMemberName: jest.fn().mockResolvedValue(''),
    } as unknown as ProjectMembersService,
  );

  const validate = (type: string, fields: Record<string, unknown>, isCreate = true) =>
    (
      svc as unknown as {
        validateTypeProfile: (t: string, f: Record<string, unknown>, c: boolean) => void;
      }
    ).validateTypeProfile(type, fields, isCreate);

  it('rejects direction on task', () => {
    expect(() =>
      validate('task', {
        title: 't',
        dueDate: Date.now(),
        reminderOffset: 'none',
        direction: 'inbound',
      }),
    ).toThrow(RpcException);
  });

  it('rejects priority on call', () => {
    expect(() =>
      validate('call', {
        title: 'c',
        direction: 'inbound',
        dueDate: Date.now(),
        reminderOffset: 'none',
        priority: 'high',
      }),
    ).toThrow(RpcException);
  });

  it('rejects location on call', () => {
    expect(() =>
      validate('call', {
        title: 'c',
        direction: 'inbound',
        dueDate: Date.now(),
        reminderOffset: 'none',
        location: 'office',
      }),
    ).toThrow(RpcException);
  });
});
