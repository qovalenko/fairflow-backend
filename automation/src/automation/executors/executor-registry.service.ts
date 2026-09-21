import { Injectable } from '@nestjs/common';
import type { ActionExecutor } from './executor.types';
import { ActivityExecutor } from './activity-executor';
import { EmailExecutor } from './email-executor';
import { CrmEntityExecutor } from './crm-entity-executor';
import { NotificationExecutor } from './notification-executor';
import { DocumentExecutor } from './document-executor';
import { QualifyDealExecutor } from './qualify-deal-executor';

/**
 * Legacy / editor-side action ids mapped onto the canonical catalog id.
 *
 * The v2 canvas ships a fallback palette (`modules/automation/src/v2/registry.ts`)
 * that uses `create_task` / `move_stage` / `create_notification` when the backend
 * registry has not loaded yet, and old rules were saved with those ids. Mapping
 * them here keeps such a rule executable instead of failing it as "no executor".
 */
const ALIASES: Record<string, string> = {
  create_task: 'create_activity',
  move_stage: 'change_stage',
  create_notification: 'send_notification',
};

/**
 * Maps an automation action `type` to the {@link ActionExecutor} that dispatches
 * it to its target domain (contract §1 executor list). `send_webhook` is handled
 * directly by the dispatcher (outbound HTTP), not via an executor; every other
 * CRM action resolves here. Returns `null` for an action with no wired executor
 * so the dispatcher records it `deferred` rather than a false success.
 */
@Injectable()
export class ExecutorRegistry {
  private readonly byType = new Map<string, ActionExecutor>();

  constructor(
    private readonly activity: ActivityExecutor,
    private readonly email: EmailExecutor,
    private readonly entity: CrmEntityExecutor,
    private readonly notification: NotificationExecutor,
    private readonly documents: DocumentExecutor,
    private readonly qualifyDeal: QualifyDealExecutor,
  ) {
    this.register(activity);
    // send_email → notification.SendTransactionalEmail (TODO-039). Before this
    // every order type with an email final action was guaranteed to land in
    // SEND_ERROR (`executor_unavailable`) while the UI offered the option.
    this.register(email);
    // TODO-039 (remainder): assign_user / change_stage / update_field and
    // send_notification. Until these four were wired the rule editor offered
    // them, the rule saved, and at trigger time the action silently did nothing.
    this.register(entity);
    this.register(notification);
    this.register(documents);
    this.register(qualifyDeal);
  }

  private register(executor: ActionExecutor): void {
    for (const type of executor.handles) this.byType.set(type, executor);
  }

  forAction(type: string): ActionExecutor | null {
    const canonical = ALIASES[type] ?? type;
    return this.byType.get(type) ?? this.byType.get(canonical) ?? null;
  }
}
