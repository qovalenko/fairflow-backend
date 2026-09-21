import { getNotificationEventSpec } from '@fairflow/shared';

const DEFAULT_SEND_CATEGORY = 'data';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function eventTypeFromDataJson(dataJson: string | undefined): string {
  const raw = (dataJson ?? '').trim();
  if (!raw) return '';
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return str(data.eventType ?? data.event_type).trim();
  } catch {
    return '';
  }
}

/** Resolve feed category for direct Send (TODO-404). */
export function resolveSendCategory(input: {
  category?: string;
  event_type?: string;
  data_json?: string;
}): { category: string; event_type: string } {
  const explicitCategory = str(input.category).trim();
  const explicitEventType = str(input.event_type).trim();
  const eventType = explicitEventType || eventTypeFromDataJson(input.data_json);

  if (explicitCategory) {
    return { category: explicitCategory, event_type: eventType };
  }

  if (eventType) {
    const spec = getNotificationEventSpec(eventType);
    if (spec?.category) {
      return { category: spec.category, event_type: eventType };
    }
  }

  return { category: DEFAULT_SEND_CATEGORY, event_type: eventType };
}
