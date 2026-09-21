import { RpcException } from '@nestjs/microservices';
import { ObjectId } from 'mongodb';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  const auditEventsCollection = {
    insertOne: jest.fn(),
    countDocuments: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
  } as any;

  const mongo = {
    auditEvents: jest.fn(() => auditEventsCollection),
  } as any;

  const rabbit = {
    consume: jest.fn(),
  } as any;

  const chain = {
    claimMessage: jest.fn(),
    confirmMessage: jest.fn(),
    append: jest.fn(),
    verify: jest.fn(),
  } as any;

  const metrics = {
    recordEventConsumed: jest.fn(),
    setDlqDepth: jest.fn(),
    recordIngestRejected: jest.fn(),
  } as any;

  const service = new AuditService(mongo, rabbit, chain, metrics);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('validates required fields for appendEvent', async () => {
    await expect(
      service.appendEvent('p-1', {
        event_name: '',
        entity_type: 'deal',
        entity_id: 'd-1',
        actor_id: 'u-1',
        actor_type: 'user',
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('appends event successfully via the hash-chain', async () => {
    const chainRecord = {
      chainKey: 'record|p-2',
      seq: 1,
      action: 'crm.deal.updated.v1',
      subject: 'deal/d-1',
      createdAt: Date.now(),
    };
    chain.append.mockResolvedValue(chainRecord);
    auditEventsCollection.findOne.mockResolvedValue({
      _id: new ObjectId(),
      projectId: 'p-2',
      eventName: 'crm.deal.updated.v1',
      entityType: 'deal',
      entityId: 'd-1',
      actorId: 'u-2',
      actorType: 'user',
      payloadJson: '{"stage":"won"}',
      createdAt: chainRecord.createdAt,
    });

    const result = await service.appendEvent('p-2', {
      event_name: 'crm.deal.updated.v1',
      entity_type: 'deal',
      entity_id: 'd-1',
      actor_id: 'u-2',
      actor_type: 'user',
      payload_json: '{"stage":"won"}',
    });

    expect(chain.append).toHaveBeenCalled();
    expect(auditEventsCollection.insertOne).not.toHaveBeenCalled();
    expect(result.project_id).toBe('p-2');
    expect(result.event_name).toBe('crm.deal.updated.v1');
  });

  it('returns NOT_FOUND for unknown event id', async () => {
    auditEventsCollection.findOne.mockResolvedValue(null);
    const existingButNotFoundId = new ObjectId().toString();

    await expect(service.getEvent('p-3', existingButNotFoundId)).rejects.toBeInstanceOf(RpcException);
  });

  it('ingests a control.* (R8) event into the record-level chain (BOX scope)', async () => {
    chain.claimMessage.mockResolvedValue(true);
    await service.ingestEvent({
      type: 'control.role.changed',
      messageId: 'm1',
      idempotencyKey: 'role:changed:1',
      organizationId: 'org_1',
      projectId: 'p1',
      userId: 'u_1',
      payload: { before: { permissions: [] }, after: { permissions: ['deal:read'] } },
    });
    expect(chain.append).toHaveBeenCalledTimes(1);
    const arg = chain.append.mock.calls[0][0];
    expect(arg.chainKey).toBe('record|p1');
    expect(arg.action).toBe('control.role.changed');
    expect(arg.data.category).toBe('permission');
  });

  it('dedups a re-delivered event (no duplicate chain record)', async () => {
    chain.claimMessage.mockResolvedValue(false);
    await service.ingestEvent({
      type: 'control.module.enabled',
      messageId: 'm2',
      idempotencyKey: 'module:enabled:1',
      organizationId: 'org_1',
    });
    expect(chain.append).not.toHaveBeenCalled();
  });

  it('routes crm.* to the record-level chain and rejects when no projectId', async () => {
    chain.claimMessage.mockResolvedValue(true);
    await service.ingestEvent({ type: 'crm.deal.updated', messageId: 'm3', projectId: 'p9', payload: {} });
    expect(chain.append.mock.calls[0][0].chainKey).toBe('record|p9');

    chain.append.mockClear();
    await service.ingestEvent({ type: 'crm.deal.updated', messageId: 'm4', payload: {} });
    expect(chain.append).not.toHaveBeenCalled();
    expect(metrics.recordIngestRejected).toHaveBeenCalledWith('missing_project_id');
  });

  it('anchors gateway.auth.* without projectId to the system record chain', async () => {
    chain.claimMessage.mockResolvedValue(true);
    await service.ingestEvent({
      type: 'gateway.auth.login',
      messageId: 'm-login',
      userId: 'u-1',
      payload: { method: 'password' },
    });
    expect(chain.append.mock.calls[0][0].chainKey).toBe('record|system');
  });

  // P8 T5.2 (X-10): every control rights/org/policy group that control now emits
  // via the outbox reaches the org-level chain exactly once. The envelope shape
  // here mirrors ControlEventEmitter (control/src/outbox/control-event.emitter.ts):
  // top-level type/idempotencyKey/userId/projectId + a nested payload carrying
  // organizationId. The consumer anchors these to `org|<orgId>|<projectId>`.
  const controlGroups: Array<{ name: string; type: string }> = [
    { name: 'role created/changed', type: 'control.role.changed' },
    { name: 'assignment granted', type: 'control.role.assigned' },
    { name: 'assignment revoked', type: 'control.role.revoked' },
    { name: 'grant changed', type: 'control.grant.changed' },
    { name: 'employee added', type: 'control.member.added' },
    { name: 'employee removed', type: 'control.member.removed' },
    { name: 'employee changed', type: 'control.member.changed' },
    { name: 'department/unit changed', type: 'control.department.changed' },
    { name: 'invitation created', type: 'control.invitation.created' },
    { name: 'invitation accepted', type: 'control.invitation.accepted' },
    { name: 'invitation revoked', type: 'control.invitation.revoked' },
    { name: 'org changed', type: 'control.org.changed' },
    { name: 'record shared', type: 'control.record.shared' },
    { name: 'record unshared', type: 'control.record.unshared' },
    { name: 'visibility changed', type: 'control.visibility.changed' },
    { name: 'module policy updated', type: 'control.policy.updated' },
    { name: 'access denied', type: 'control.access.denied' },
  ];

  it.each(controlGroups)('ingests control group "$name" into the record-level chain', async ({ type }) => {
    chain.claimMessage.mockResolvedValue(true);
    await service.ingestEvent({
      type,
      messageId: `mid-${type}`,
      idempotencyKey: `idem-${type}`,
      userId: 'actor-1',
      projectId: 'p-1',
      payload: { action: 'x', organizationId: 'org-7', projectId: 'p-1' },
    });
    expect(chain.append).toHaveBeenCalledTimes(1);
    const arg = chain.append.mock.calls[0][0];
    expect(arg.chainKey).toBe('record|p-1');
    expect(arg.action).toBe(type);
    expect(arg.data.category).toBe('permission');
    expect(arg.idempotencyKey).toBe(`idem-${type}`);
  });

  it('ingests chat.message.edited with originalText into the audit chain data', async () => {
    chain.claimMessage.mockResolvedValue(true);
    await service.ingestEvent({
      type: 'chat.message.edited',
      messageId: 'm-chat-edit',
      projectId: 'p1',
      userId: 'u1',
      payload: {
        conversationId: 'c1',
        messageId: 'm1',
        editedAt: 123,
        originalText: 'до правки',
        newText: 'после',
      },
    });
    expect(chain.append).toHaveBeenCalledTimes(1);
    const arg = chain.append.mock.calls[0][0];
    expect(arg.action).toBe('chat.message.edited');
    expect(arg.data.originalText).toBe('до правки');
    expect(arg.data.newText).toBe('после');
  });

  it('is idempotent per control group: a re-delivery of any of them appends nothing', async () => {
    for (const { type } of controlGroups) {
      chain.append.mockClear();
      chain.claimMessage.mockResolvedValue(false); // key already claimed
      await service.ingestEvent({
        type,
        messageId: `mid-${type}`,
        idempotencyKey: `idem-${type}`,
        payload: { organizationId: 'org-7' },
      });
      expect(chain.append).not.toHaveBeenCalled();
    }
  });

  // TODO-033: a transient append failure must NOT consume the dedup claim —
  // the error propagates (message goes to retry), confirmMessage is not called,
  // and the redelivery (claim still allowed) appends the event and only then
  // confirms. The old single-phase claim marked the message processed BEFORE
  // append, so the retry was silently skipped and the event lost forever.
  it('confirms the dedup claim only after a successful append (retry re-processes)', async () => {
    const payload = {
      type: 'crm.deal.updated',
      messageId: 'm-retry',
      idempotencyKey: 'idem-retry',
      projectId: 'p1',
      payload: {},
    };

    chain.claimMessage.mockResolvedValue(true);
    chain.append.mockRejectedValueOnce(new Error('mongo down'));
    await expect(service.ingestEvent(payload)).rejects.toThrow('mongo down');
    expect(chain.confirmMessage).not.toHaveBeenCalled();

    // Redelivery after retry: claim is still 'pending' → allowed to re-process.
    chain.append.mockResolvedValueOnce({ seq: 1 });
    await service.ingestEvent(payload);
    expect(chain.append).toHaveBeenCalledTimes(2);
    expect(chain.confirmMessage).toHaveBeenCalledTimes(1);
    expect(chain.confirmMessage).toHaveBeenCalledWith('idem-retry');
  });

  it('falls back to messageId for dedup when no idempotencyKey is set', async () => {
    chain.claimMessage.mockResolvedValue(true);
    await service.ingestEvent({
      type: 'control.member.added',
      messageId: 'only-message-id',
      payload: { organizationId: 'org-7' },
    });
    expect(chain.claimMessage).toHaveBeenCalledWith('only-message-id');
  });

  it('rejects ingest when event name is missing', async () => {
    await service.ingestEvent({ messageId: 'm-empty', projectId: 'p1' });
    expect(chain.append).not.toHaveBeenCalled();
    expect(metrics.recordIngestRejected).toHaveBeenCalledWith('missing_event_name');
  });

  it('classifies gateway.auth.* as security and resolves projectId from nested payload', async () => {
    chain.claimMessage.mockResolvedValue(true);
    await service.ingestEvent({
      type: 'gateway.auth.logout',
      messageId: 'm-logout',
      payload: { projectId: 'nested-p', reason: 'session_expired' },
    });
    const arg = chain.append.mock.calls[0][0];
    expect(arg.chainKey).toBe('record|nested-p');
    expect(arg.data.category).toBe('security');
  });

  it('verifyChain requires projectId for record-level chains', async () => {
    await expect(service.verifyChain({ level: 'record' })).rejects.toBeInstanceOf(RpcException);
    chain.verify.mockResolvedValue({ status: 'ok', checked: 0 });
    const result = await service.verifyChain({ projectId: 'p1' });
    expect(result.chainKey).toBe('record|p1');
    expect(chain.verify).toHaveBeenCalledWith('record|p1');
  });

  it('verifyChain requires organizationId for org-level chains', async () => {
    await expect(service.verifyChain({ level: 'org' })).rejects.toBeInstanceOf(RpcException);
    chain.verify.mockResolvedValue({ status: 'ok', checked: 1 });
    const result = await service.verifyChain({ level: 'org', organizationId: 'org-1', projectId: 'p1' });
    expect(result.chainKey).toBe('org|org-1|p1');
  });

  it('listEvents paginates, clamps page size and applies entity filters', async () => {
    const cursor = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([
        {
          _id: new ObjectId(),
          projectId: 'p-list',
          action: 'crm.contact.updated',
          subject: 'contact/c-1',
          actorId: 'u-1',
          actorType: 'user',
          createdAt: 100,
        },
      ]),
    };
    auditEventsCollection.countDocuments.mockResolvedValue(1);
    auditEventsCollection.find.mockReturnValue(cursor);

    const result = await service.listEvents('p-list', 0, 500, ' contact ', ' c-1 ');

    expect(auditEventsCollection.find).toHaveBeenCalledWith({
      projectId: 'p-list',
      entityType: 'contact',
      entityId: 'c-1',
    });
    expect(cursor.limit).toHaveBeenCalledWith(100);
    expect(result.total).toBe(1);
    expect(result.list[0].entity_type).toBe('contact');
    expect(result.list[0].entity_id).toBe('c-1');
  });

  it('getEvent returns a mapped row for an existing event', async () => {
    const id = new ObjectId();
    auditEventsCollection.findOne.mockResolvedValue({
      _id: id,
      projectId: 'p-get',
      eventName: 'crm.deal.created',
      entityType: 'deal',
      entityId: 'd-9',
      actorId: 'u-9',
      actorType: 'user',
      payloadJson: '{"x":1}',
      createdAt: 42,
    });

    const row = await service.getEvent('p-get', id.toString());
    expect(row.id).toBe(id.toString());
    expect(row.event_name).toBe('crm.deal.created');
    expect(row.payload_json).toBe('{"x":1}');
  });

  it('appendEvent rejects missing project_id and parses invalid payload_json safely', async () => {
    await expect(
      service.appendEvent('', {
        event_name: 'crm.deal.updated',
        entity_type: 'deal',
        entity_id: 'd-1',
        actor_id: 'u-1',
        actor_type: 'user',
      }),
    ).rejects.toBeInstanceOf(RpcException);

    chain.append.mockResolvedValue({
      chainKey: 'record|p-fallback',
      seq: 1,
      createdAt: 99,
    });
    auditEventsCollection.findOne.mockResolvedValue(null);

    const row = await service.appendEvent('p-fallback', {
      event_name: 'crm.deal.updated',
      entity_type: 'deal',
      entity_id: 'd-1',
      actor_id: 'u-1',
      actor_type: 'user',
      payload_json: '{not-json',
    });

    expect(chain.append.mock.calls.at(-1)?.[0].data.payload).toEqual({ raw: '{not-json' });
    expect(row.project_id).toBe('p-fallback');
    expect(row.created_at).toBe(99);
  });

  it('onModuleInit wires the consumer and polls DLQ depth', async () => {
    rabbit.consume.mockResolvedValue(undefined);
    rabbit.dlqDepth = jest.fn().mockResolvedValue(2);
    jest.useFakeTimers();

    await service.onModuleInit();
    expect(rabbit.consume).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['crm.#', 'control.#']),
      expect.any(Function),
      expect.objectContaining({ onConsumed: expect.any(Function), onDeadLettered: expect.any(Function) }),
    );
    expect(metrics.setDlqDepth).toHaveBeenCalledWith(2);

    rabbit.dlqDepth.mockResolvedValue(5);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(metrics.setDlqDepth).toHaveBeenCalledWith(5);

    service.onModuleDestroy();
    jest.useRealTimers();
  });
});
