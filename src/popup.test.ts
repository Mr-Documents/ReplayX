import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeState } from './messages';
import type { SessionData, SessionSummary } from './types';

/**
 * The popup renders values that originate from arbitrary recorded web pages and
 * from user-supplied import files. These tests pin the rule that none of it is
 * ever interpreted as markup.
 */

const POPUP_HTML = `
  <h2>ReplayX <span id="status" class="status-pill">Idle</span></h2>
  <div id="error-banner" style="display:none"></div>
  <div class="controls">
    <button id="start-btn"></button>
    <button id="pause-btn"></button>
    <button id="resume-btn"></button>
    <button id="stop-btn"></button>
  </div>
  <div id="replay-controls" style="display:none">
    <span id="speed-value"></span>
    <input type="range" id="speed-control" min="0.1" max="5" step="0.1" value="1">
    <button id="step-btn"></button>
    <button id="stop-replay-btn"></button>
    <span id="progress-label"></span>
    <div id="timeline"><div id="progress-bar"></div></div>
  </div>
  <input type="file" id="import-input">
  <button id="import-btn"></button>
  <div id="sessions"></div>
  <div id="session-debugger" style="display:none"></div>
`;

/** Marker for "the background did not answer at all". */
const NO_RESPONSE = Symbol('no-response');

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    url: 'https://example.com/app',
    startTime: 1_700_000_000_000,
    metadata: {
      userAgent: 'test',
      viewport: { width: 800, height: 600 },
      totalEvents: 4,
      duration: 2_500,
      pageUrls: ['https://example.com/app'],
    },
    ...overrides,
  } as SessionSummary;
}

function idleState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    isRecording: false,
    isPaused: false,
    currentSessionId: null,
    recordingStartTime: null,
    currentTabId: null,
    isReplaying: false,
    isReplayPaused: false,
    activeReplaySession: null,
    replaySpeed: 1,
    replayProgressIndex: 0,
    replayTotalEvents: 0,
    ...overrides,
  };
}

/** Boots the popup module against a scripted background. */
async function mountPopup(responses: Record<string, unknown>): Promise<void> {
  document.body.innerHTML = POPUP_HTML;

  chromeStub.runtime.sendMessage.mockImplementation(
    (message: { action: string }, callback?: (response: unknown) => void) => {
      const scripted = Object.prototype.hasOwnProperty.call(responses, message.action)
        ? responses[message.action]
        : { success: true };
      // NO_RESPONSE models a message the background never answered.
      const response = scripted === NO_RESPONSE ? undefined : scripted;
      callback?.(response);
      return Promise.resolve(response);
    },
  );

  vi.resetModules();
  await import('./popup');
  // Let the initial GET_STATE / GET_SESSIONS promises settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('session list rendering', () => {
  it('renders a session row from summary metadata', async () => {
    await mountPopup({
      GET_STATE: idleState(),
      GET_SESSIONS: { sessions: [summary()] },
    });

    const container = document.getElementById('sessions')!;
    expect(container.querySelectorAll('.session-item')).toHaveLength(1);
    expect(container.textContent).toContain('Events: 4');
    expect(container.textContent).toContain('2.5s');
  });

  it('shows an empty state when there are no sessions', async () => {
    await mountPopup({ GET_STATE: idleState(), GET_SESSIONS: { sessions: [] } });
    expect(document.getElementById('sessions')!.textContent).toContain('No sessions recorded yet');
  });

  it('never interprets a recorded url as markup', async () => {
    // A page can control its own URL, and this string used to be interpolated
    // straight into innerHTML on a privileged extension page.
    const hostile = 'https://evil.test/"><img src=x onerror=alert(1)>';
    await mountPopup({
      GET_STATE: idleState(),
      GET_SESSIONS: { sessions: [summary({ url: hostile })] },
    });

    const container = document.getElementById('sessions')!;
    // No element is created: the display text is percent-encoded by URL parsing
    // and the raw value only reaches the title attribute, set as a property.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.session-item')).not.toBeNull();
    expect(container.querySelector('span[title]')?.getAttribute('title')).toBe(hostile);
    expect(container.textContent).not.toContain('<img');
  });

  it('escapes hostile session ids', async () => {
    await mountPopup({
      GET_STATE: idleState(),
      GET_SESSIONS: { sessions: [summary({ id: '"><script>alert(1)</script>' })] },
    });
    expect(document.getElementById('sessions')!.querySelector('script')).toBeNull();
  });

  it('reports a background failure instead of throwing on an undefined response', async () => {
    // `response.error` was read without a null check, so a dropped message
    // produced a TypeError and the list silently stayed blank.
    await mountPopup({ GET_STATE: idleState(), GET_SESSIONS: NO_RESPONSE });
    const banner = document.getElementById('error-banner')!;
    expect(banner.style.display).toBe('block');
    expect(banner.textContent).toMatch(/background/i);
  });
});

describe('debugger panel', () => {
  const hostileSession = (): SessionData =>
    ({
      ...summary(),
      events: [
        {
          id: 'e1',
          sessionId: 'session-1',
          timestamp: 10,
          type: 'Click',
          payload: {
            selector: '#a',
            x: 1,
            y: 2,
            textSnippet: '<img src=x onerror="alert(1)">',
          },
        },
      ],
      replayErrors: [
        {
          code: 'dom_mismatch',
          message: '<script>alert("xss")</script>',
          details: '<iframe src="javascript:alert(1)"></iframe>',
          severity: 'warning',
        },
      ],
    }) as unknown as SessionData;

  async function openDebugger(): Promise<HTMLElement> {
    await mountPopup({
      GET_STATE: idleState(),
      GET_SESSIONS: { sessions: [summary()] },
      GET_SESSION: { session: hostileSession() },
    });

    (document.querySelector('.view-btn') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return document.getElementById('session-debugger')!;
  }

  it('renders replay issues as text, never as markup', async () => {
    const panel = await openDebugger();
    expect(panel.style.display).toBe('block');
    expect(panel.textContent).toContain('<script>alert("xss")</script>');
    expect(panel.querySelector('script')).toBeNull();
    expect(panel.querySelector('iframe')).toBeNull();
  });

  it('renders recorded page text as text', async () => {
    const panel = await openDebugger();
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(panel.innerHTML).toContain('&lt;img');
  });

  it('toggles closed when View is pressed again', async () => {
    const panel = await openDebugger();
    (document.querySelector('.view-btn') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.style.display).toBe('none');
  });
});

describe('replay controls', () => {
  it('shows progress while replaying', async () => {
    await mountPopup({
      GET_STATE: idleState({ isReplaying: true, replayProgressIndex: 5, replayTotalEvents: 20 }),
      GET_SESSIONS: { sessions: [] },
    });

    expect(document.getElementById('replay-controls')!.style.display).toBe('block');
    // The progress bar existed in the markup but nothing ever updated it.
    expect(document.getElementById('progress-bar')!.style.width).toBe('25%');
    expect(document.getElementById('progress-label')!.textContent).toBe('5 / 20');
  });

  it('reflects recording status', async () => {
    await mountPopup({
      GET_STATE: idleState({ isRecording: true }),
      GET_SESSIONS: { sessions: [] },
    });
    expect(document.getElementById('status')!.textContent).toMatch(/Recording/);
    expect((document.getElementById('start-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('stop-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('reflects a paused replay', async () => {
    await mountPopup({
      GET_STATE: idleState({ isReplaying: true, isReplayPaused: true }),
      GET_SESSIONS: { sessions: [] },
    });
    expect(document.getElementById('status')!.textContent).toMatch(/Paused/);
    expect(document.getElementById('resume-btn')!.style.display).toBe('inline-block');
  });
});

describe('recording actions', () => {
  it('reverts the optimistic state when starting fails', async () => {
    await mountPopup({
      GET_STATE: idleState(),
      GET_SESSIONS: { sessions: [] },
      START_RECORDING: { success: false, error: 'Only http(s) pages are supported' },
    });

    (document.getElementById('start-btn') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.getElementById('error-banner')!.textContent).toContain('http(s)');
    expect((document.getElementById('start-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('surfaces a step failure', async () => {
    await mountPopup({
      GET_STATE: idleState({ isReplaying: true }),
      GET_SESSIONS: { sessions: [] },
      STEP_REPLAY: { success: false, error: 'No replay is in progress.' },
    });

    (document.getElementById('step-btn') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.getElementById('error-banner')!.textContent).toContain('No replay');
  });
});
