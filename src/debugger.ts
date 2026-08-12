import type {
  ChangePayload,
  ClickPayload,
  InputPayload,
  NavigationPayload,
  NetworkPayload,
  RecordedEvent,
  ScrollPayload,
  SessionData,
  SubmitPayload,
  TargetPayload,
} from './types';

export interface ReplayStatusBadge {
  label: string;
  variant: 'default' | 'success' | 'warning';
  count: number;
}

export function getReplayStatusBadge(
  session: Pick<SessionData, 'replayErrors' | 'metadata'>,
): ReplayStatusBadge {
  const issueCount = session.replayErrors?.length || session.metadata?.replayIssues || 0;
  if (issueCount > 0) return { label: 'Issues', variant: 'warning', count: issueCount };
  return { label: 'Healthy', variant: 'success', count: 0 };
}

export interface EventDetail {
  title: string;
  meta: string;
  body: string;
}

function truncate(value: unknown, max: number): string {
  const text = value === undefined || value === null ? '' : String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function getEventDetailSummary(event: RecordedEvent): EventDetail {
  switch (event.type) {
    case 'Network': {
      const payload = event.payload as NetworkPayload;
      return {
        title: `${payload.method || 'GET'} ${payload.url ?? ''}`.trim(),
        meta: [
          `Status ${payload.responseStatus ?? 'n/a'}`,
          payload.duration ? `${Math.round(payload.duration)}ms` : 'timing unavailable',
          payload.truncated ? 'body truncated' : '',
        ]
          .filter(Boolean)
          .join(' • '),
        body: `Request: ${truncate(payload.requestBody, 120) || 'n/a'}\nResponse: ${
          truncate(payload.responseBody, 120) || 'n/a'
        }`,
      };
    }

    case 'Click':
    case 'DoubleClick': {
      const payload = event.payload as ClickPayload;
      return {
        title: `${event.type} ${payload.selector || 'unknown'}`,
        meta: payload.textSnippet ? `Text: ${truncate(payload.textSnippet, 40)}` : 'No text snippet',
        body: `Coordinates: ${payload.x}, ${payload.y}`,
      };
    }

    case 'Input':
    case 'Change': {
      const payload = event.payload as InputPayload | ChangePayload;
      return {
        title: `${event.type} ${payload.selector || 'unknown'}`,
        meta: payload.masked ? 'Value masked (sensitive field)' : `Value: ${truncate(payload.value, 40)}`,
        body: payload.inputType ? `Input type: ${payload.inputType}` : '',
      };
    }

    case 'Submit': {
      const payload = event.payload as SubmitPayload;
      return {
        title: `Submit ${payload.selector || 'unknown'}`,
        meta: `Action: ${payload.formAction || 'n/a'}`,
        body: payload.formMethod ? `Method: ${payload.formMethod}` : '',
      };
    }

    case 'Navigation': {
      const payload = event.payload as NavigationPayload;
      return {
        title: `Navigation ${payload.url ?? ''}`,
        meta: payload.navigationType ?? 'navigate',
        body: payload.referrer ? `Referrer: ${payload.referrer}` : '',
      };
    }

    case 'Scroll': {
      const payload = event.payload as ScrollPayload;
      return {
        title: `Scroll ${payload.selector || 'window'}`,
        meta: `top ${payload.scrollTop}, left ${payload.scrollLeft}`,
        body: '',
      };
    }

    default: {
      const payload = event.payload as Partial<TargetPayload>;
      return {
        title: event.type,
        meta: payload.selector ? `Target: ${payload.selector}` : 'No additional detail',
        body: '',
      };
    }
  }
}

/** One-line description used in the popup event timeline. */
export function summarizeEvent(event: RecordedEvent): string {
  const detail = getEventDetailSummary(event);
  return [detail.meta, detail.body].filter(Boolean).join(' — ');
}
