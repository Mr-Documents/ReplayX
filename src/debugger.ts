import { SessionData, RecordedEvent } from './types';

export interface ReplayStatusBadge {
  label: string;
  variant: 'default' | 'success' | 'warning';
  count: number;
}

export function getReplayStatusBadge(session: Pick<SessionData, 'replayErrors' | 'metadata'>): ReplayStatusBadge {
  const issueCount = session.replayErrors?.length || session.metadata?.replayIssues || 0;

  if (issueCount > 0) {
    return { label: 'Issues', variant: 'warning', count: issueCount };
  }

  return { label: 'Healthy', variant: 'success', count: 0 };
}

export function getEventDetailSummary(event: RecordedEvent) {
  const base = {
    title: '',
    meta: '',
    body: ''
  };

  switch (event.type) {
    case 'Network': {
      const payload = event.payload;
      base.title = `${payload.method || 'GET'} ${payload.url || ''}`.trim();
      base.meta = `Status ${payload.responseStatus || 'n/a'} • ${payload.duration ? `${payload.duration}ms` : 'timing unavailable'}`;
      base.body = `Request: ${payload.requestBody ? payload.requestBody.slice(0, 100) : 'n/a'}\nResponse: ${payload.responseBody ? payload.responseBody.slice(0, 100) : 'n/a'}`;
      return base;
    }
    case 'Click':
    case 'DoubleClick':
      base.title = `Click ${event.payload.selector || 'unknown'}`;
      base.meta = event.payload.textSnippet ? `Text: ${event.payload.textSnippet.slice(0, 40)}` : 'No text snippet';
      return base;
    case 'Input':
    case 'Change':
      base.title = `Input ${event.payload.selector || 'unknown'}`;
      base.meta = `Value: ${String(event.payload.value || '').slice(0, 40)}`;
      return base;
    case 'Navigation':
      base.title = `Navigation ${event.payload.url || ''}`;
      base.meta = event.payload.navigationType || 'navigate';
      return base;
    default:
      base.title = event.type;
      base.meta = 'No additional detail';
      return base;
  }
}
