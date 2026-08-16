import type {
  ChangePayload,
  ClickPayload,
  InputPayload,
  KeyPayload,
  MutationPayload,
  NavigationPayload,
  NetworkPayload,
  RecordedEvent,
  ResizePayload,
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

    case 'Mutation': {
      // Mutation payloads key the target as `targetSelector`, so the generic
      // `payload.selector` fallback could never describe one - every DOM
      // mutation rendered as "No additional detail".
      const payload = event.payload as MutationPayload;
      const added = payload.addedNodes?.length ?? 0;
      const removed = payload.removedNodes?.length ?? 0;

      let meta: string;
      if (payload.type === 'attributes') {
        meta = `${payload.attributeName || 'attribute'} changed`;
      } else if (payload.type === 'characterData') {
        meta = 'text changed';
      } else {
        meta = [added ? `+${added} node${added === 1 ? '' : 's'}` : '', removed ? `-${removed}` : '']
          .filter(Boolean)
          .join(' ') || 'no net change';
      }

      return {
        title: `Mutation (${payload.type})`,
        meta: `${payload.targetSelector || 'unknown target'} — ${meta}`,
        body: describeMutationChange(payload),
      };
    }

    case 'Key': {
      const payload = event.payload as KeyPayload;
      const modifiers = [
        payload.ctrlKey ? 'Ctrl' : '',
        payload.altKey ? 'Alt' : '',
        payload.shiftKey ? 'Shift' : '',
        payload.metaKey ? 'Meta' : '',
      ].filter(Boolean);
      const combo = [...modifiers, payload.key].join('+');
      return {
        title: `Key ${payload.kind === 'up' ? 'up' : 'down'}`,
        meta: combo || 'unknown key',
        body: payload.code ? `Code: ${payload.code}` : '',
      };
    }

    case 'Resize': {
      const payload = event.payload as ResizePayload;
      return {
        title: 'Resize',
        meta: `${payload.width} x ${payload.height}`,
        body: '',
      };
    }

    case 'Focus':
    case 'Blur': {
      const payload = event.payload as TargetPayload;
      return {
        title: `${event.type} ${payload.selector || 'unknown'}`,
        meta: payload.targetTag ? `<${payload.targetTag}>` : 'No target tag recorded',
        body: '',
      };
    }

    default: {
      // Every known event type is handled above, so `event` narrows to never.
      // This branch only catches data written by a future or older build.
      const unknown = event as RecordedEvent;
      const payload = unknown.payload as Partial<TargetPayload>;
      return {
        title: String(unknown.type),
        meta: payload?.selector ? `Target: ${payload.selector}` : 'No additional detail',
        body: '',
      };
    }
  }
}

function describeMutationChange(payload: MutationPayload): string {
  if (payload.type === 'attributes') {
    return `${payload.oldValue ? `was: ${truncate(payload.oldValue, 60)}\n` : ''}now: ${truncate(
      payload.attributeValue,
      60,
    )}`;
  }
  if (payload.type === 'characterData') {
    return `${payload.oldValue ? `was: ${truncate(payload.oldValue, 60)}\n` : ''}now: ${truncate(
      payload.newValue,
      60,
    )}`;
  }
  const first = payload.addedNodes?.[0] ?? payload.removedNodes?.[0];
  return first ? truncate(first, 100) : '';
}

/** One-line description used in the popup event timeline. */
export function summarizeEvent(event: RecordedEvent): string {
  const detail = getEventDetailSummary(event);
  return [detail.meta, detail.body].filter(Boolean).join(' — ');
}

export type TimelineEntry =
  | { kind: 'event'; event: RecordedEvent }
  | { kind: 'run'; count: number; from: number; to: number };

/**
 * Collapses consecutive DOM mutations into a single entry.
 *
 * A page load can emit hundreds of mutations in a burst; listed individually
 * they push the clicks and inputs the user is actually looking for off the end
 * of the timeline. Runs are only collapsed when there are at least two in a
 * row, so an isolated mutation is still shown in full.
 */
export function collapseTimeline(events: readonly RecordedEvent[], limit = 25): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (let i = 0; i < events.length && entries.length < limit; i++) {
    const event = events[i];
    if (!event) continue;

    if (event.type !== 'Mutation') {
      entries.push({ kind: 'event', event });
      continue;
    }

    let end = i;
    while (end + 1 < events.length && events[end + 1]?.type === 'Mutation') end += 1;

    const count = end - i + 1;
    if (count === 1) {
      entries.push({ kind: 'event', event });
    } else {
      entries.push({
        kind: 'run',
        count,
        from: event.timestamp,
        to: events[end]?.timestamp ?? event.timestamp,
      });
    }
    i = end;
  }

  return entries;
}
