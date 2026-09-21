import type { BoxMongoReader } from './box-mongo';
import { waitFor } from './wait-for';

export function summarizeExecutions(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return 'no automation_rule_executions rows';
  return rows
    .slice(0, 5)
    .map((row) => {
      const parts = [
        `status=${String(row.status ?? '?')}`,
        `trigger=${String(row.trigger_event_name ?? row.triggerEventName ?? '?')}`,
      ];
      const err = String(row.error ?? row.skip_reason ?? row.error_code ?? '').trim();
      if (err) parts.push(`error=${err}`);
      const actions = String(row.action_results_json ?? row.actionResultsJson ?? '').trim();
      if (actions && actions !== '[]') parts.push(`actions=${actions.slice(0, 200)}`);
      return parts.join(' ');
    })
    .join('; ');
}

/**
 * Polls an observable field change after a bus-triggered automation rule, and
 * on timeout attaches automation_rule_executions diagnostics for bug repro.
 */
export async function waitForBusTriggeredAutomation(
  mongo: BoxMongoReader,
  projectId: string,
  ruleId: string,
  poll: () => Promise<Record<string, unknown> | false>,
  label: string,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  try {
    return await waitFor(poll, { label, timeoutMs });
  } catch (err) {
    const executions = await mongo.listAutomationExecutions(projectId, ruleId);
    throw new Error(
      `${String(err)} — executions: ${summarizeExecutions(executions as Record<string, unknown>[])}`,
    );
  }
}
