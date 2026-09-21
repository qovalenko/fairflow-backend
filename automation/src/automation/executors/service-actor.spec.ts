import { GW_METADATA, parseVisibilityScope, serializeVisibilityScope } from '@fairflow/shared';
import { buildServiceActorMetadata } from './grpc-action-executor';
import { ExecutorRegistry } from './executor-registry.service';
import { ActivityExecutor } from './activity-executor';
import { EmailExecutor } from './email-executor';
import { CrmEntityExecutor } from './crm-entity-executor';
import { NotificationExecutor } from './notification-executor';
import { DocumentExecutor } from './document-executor';
import { QualifyDealExecutor } from './qualify-deal-executor';
import type { EffectLedger } from './effect-ledger.service';
import { ACTION_CATALOG } from '../registry';

const read = (m: ReturnType<typeof buildServiceActorMetadata>, key: string): string => {
  const v = m.get(key)?.[0];
  return typeof v === 'string' ? v : '';
};

describe('service-actor metadata (visibility axis)', () => {
  it('sends the s2s mode:all scope on the BUS path — without it every read is denied', () => {
    // `isRecordVisible(undefined, …)` is false and `buildVisibilityFilter`
    // returns DENY_ALL, so a missing scope header makes every existing record
    // answer NOT_FOUND and `assign_user`/`change_stage` could never do anything.
    const m = buildServiceActorMetadata({
      projectId: 'p1',
      actor: 'system',
      userId: '',
      payload: {},
    });
    const scope = parseVisibilityScope(read(m, GW_METADATA.VISIBILITY_SCOPE));
    expect(scope?.mode).toBe('all');
    expect(read(m, GW_METADATA.ACTOR_TYPE)).toBe('service');
    // Isolation still travels with the call.
    expect(read(m, GW_METADATA.PROJECT_ID)).toBe('p1');
  });

  it('does NOT widen a user run that carries no user id (integration hook IDOR)', () => {
    // The old rule was "no userId ⇒ system scope", which handed the s2s
    // `mode:'all'` scope to `POST /automation/integration/trigger` — a
    // manager-reachable route with a fully client-supplied payload. The actor,
    // not the presence of a user id, decides now.
    const m = buildServiceActorMetadata({ projectId: 'p1', actor: 'user', userId: '', payload: {} });
    expect(read(m, GW_METADATA.VISIBILITY_SCOPE)).toBe('');
  });

  it('treats an UNDECLARED actor as a user run (fail-closed default)', () => {
    const m = buildServiceActorMetadata({ projectId: 'p1', payload: {} });
    expect(read(m, GW_METADATA.VISIBILITY_SCOPE)).toBe('');
  });

  it('forwards the CALLER scope verbatim on a user-initiated run (no widening)', () => {
    const caller = serializeVisibilityScope({
      mode: 'restricted',
      level: 'custom',
      selfId: 'u1',
      ownerIds: ['u1'],
      sharedRecordIds: [],
    });
    const m = buildServiceActorMetadata({
      projectId: 'p1',
      actor: 'user',
      userId: 'u1',
      payload: {},
      visibilityScope: caller,
    });
    const scope = parseVisibilityScope(read(m, GW_METADATA.VISIBILITY_SCOPE));
    expect(scope?.mode).toBe('restricted');
    expect(scope?.ownerIds).toEqual(['u1']);
    expect(read(m, GW_METADATA.USER_ID)).toBe('u1');
  });

  it('stays fail-closed for a user run whose scope was not forwarded', () => {
    const m = buildServiceActorMetadata({
      projectId: 'p1',
      actor: 'user',
      userId: 'u1',
      payload: {},
    });
    // No scope at all → the target domain denies. Fabricating an all-scope here
    // would let a manual run mutate records its caller cannot even see.
    expect(read(m, GW_METADATA.VISIBILITY_SCOPE)).toBe('');
  });
});

describe('registry honesty filter (FR-AUTOM-130)', () => {
  const ledger = { claim: async () => true, release: async () => undefined } as unknown as EffectLedger;
  const registry = new ExecutorRegistry(
    new ActivityExecutor(),
    new EmailExecutor(),
    new CrmEntityExecutor(),
    new NotificationExecutor(ledger),
    new DocumentExecutor({ resolve: async () => undefined } as never),
    new QualifyDealExecutor(),
  );

  it('resolves an executor for EVERY catalog action except send_webhook', () => {
    // `AutomationService.isActionAvailable` hides actions with no executor from
    // the palette. Before TODO-039's remainder, four of them were hidden — or,
    // worse for rules saved earlier, offered and silently skipped at runtime.
    const unresolved = ACTION_CATALOG.map((a) => a.id)
      .filter((id) => id !== 'send_webhook')
      .filter((id) => registry.forAction(id) == null);
    expect(unresolved).toEqual([]);
  });

  it('routes the four TODO-039 actions to their executors', () => {
    expect(registry.forAction('assign_user')).toBeInstanceOf(CrmEntityExecutor);
    expect(registry.forAction('change_stage')).toBeInstanceOf(CrmEntityExecutor);
    expect(registry.forAction('update_field')).toBeInstanceOf(CrmEntityExecutor);
    expect(registry.forAction('send_notification')).toBeInstanceOf(NotificationExecutor);
  });

  it('keeps legacy editor ids executable via aliases', () => {
    expect(registry.forAction('move_stage')).toBeInstanceOf(CrmEntityExecutor);
    expect(registry.forAction('create_task')).toBeInstanceOf(ActivityExecutor);
    expect(registry.forAction('create_notification')).toBeInstanceOf(NotificationExecutor);
  });

  it('still returns null for an unknown action (no false success)', () => {
    expect(registry.forAction('teleport_deal')).toBeNull();
  });
});
