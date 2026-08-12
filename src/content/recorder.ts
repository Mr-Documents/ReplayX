import { CONTENT_SOURCE, type InterceptorMode } from '../messages';
import type {
  InitialStateSnapshot,
  MutationPayload,
  RecordedEvent,
  TargetPayload,
} from '../types';
import { buildTargetPayload, getRobustSelector, isReplayXNode } from './selector';

export interface RecorderLimits {
  maxEvents: number;
  maxSessionBytes: number;
  flushThreshold: number;
  maxMutationHtml: number;
  maxMutationsPerSecond: number;
}

export const DEFAULT_LIMITS: RecorderLimits = {
  maxEvents: 50_000,
  maxSessionBytes: 50 * 1024 * 1024,
  flushThreshold: 1_000,
  /** Serialised node HTML above this is truncated; full DOM dumps were the single largest payload source. */
  maxMutationHtml: 4_096,
  /** A hard ceiling on mutation events: animation loops can emit thousands per second. */
  maxMutationsPerSecond: 120,
};

const SCROLL_DEBOUNCE_MS = 120;
const INPUT_DEBOUNCE_MS = 50;

const SENSITIVE_NAME = /pass|card|cvv|cvc|ssn|secret|token|pin|otp|iban|account|security|credential/i;

export interface StopResult {
  events: RecordedEvent[];
  startTime: number;
  initialState: InitialStateSnapshot | null;
}

export class Recorder {
  private events: RecordedEvent[] = [];
  private sessionId = '';
  private sequenceCounter = 0;
  private sessionStartTime = 0;
  private recording = false;
  private paused = false;
  private historyLength = 0;
  private initialState: InitialStateSnapshot | null = null;
  private mutationObserver: MutationObserver | null = null;

  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingScroll: { target: Element | Window; selector: string } | null = null;
  private lastInputAt = 0;

  private approxSessionBytes = 0;
  private mutationWindowStart = 0;
  private mutationsInWindow = 0;
  private limitReached = false;

  private originalPushState: History['pushState'] | null = null;
  private originalReplaceState: History['replaceState'] | null = null;

  private readonly limits: RecorderLimits;

  private readonly onClickBound = (e: Event) => this.onClick(e as MouseEvent, false);
  private readonly onDblClickBound = (e: Event) => this.onClick(e as MouseEvent, true);
  private readonly onInputBound = (e: Event) => this.onInput(e);
  private readonly onChangeBound = (e: Event) => this.onChange(e);
  private readonly onSubmitBound = (e: Event) => this.onSubmit(e);
  private readonly onScrollBound = (e: Event) => this.onScroll(e);
  private readonly onResizeBound = () => this.onResize();
  private readonly onFocusBound = (e: Event) => this.onFocusChange(e, 'Focus');
  private readonly onBlurBound = (e: Event) => this.onFocusChange(e, 'Blur');
  private readonly onKeyDownBound = (e: Event) => this.onKey(e as KeyboardEvent, 'down');
  private readonly onKeyUpBound = (e: Event) => this.onKey(e as KeyboardEvent, 'up');
  private readonly onNavigationBound = (e: Event) => this.onNavigation(e);

  constructor(limits: Partial<RecorderLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  start(sessionId: string, sessionStartTime?: number): void {
    if (this.recording) return;
    this.recording = true;
    this.paused = false;
    this.limitReached = false;
    this.sessionId = sessionId;
    this.events = [];
    this.sequenceCounter = 0;
    this.approxSessionBytes = 0;
    this.sessionStartTime = sessionStartTime ?? Date.now();
    this.historyLength = window.history.length;

    this.initialState = {
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      localStorage: this.captureStorage(() => localStorage),
      sessionStorage: this.captureStorage(() => sessionStorage),
      cookies: this.safeCookies(),
    };

    document.addEventListener('click', this.onClickBound, true);
    document.addEventListener('dblclick', this.onDblClickBound, true);
    document.addEventListener('input', this.onInputBound, true);
    document.addEventListener('change', this.onChangeBound, true);
    document.addEventListener('submit', this.onSubmitBound, true);
    document.addEventListener('scroll', this.onScrollBound, true);
    document.addEventListener('focus', this.onFocusBound, true);
    document.addEventListener('blur', this.onBlurBound, true);
    document.addEventListener('keydown', this.onKeyDownBound, true);
    document.addEventListener('keyup', this.onKeyUpBound, true);
    window.addEventListener('resize', this.onResizeBound);

    this.setupNavigationTracking();
    this.setupMutationObserver();

    // Without this the MAIN-world interceptor stays IDLE and no network event
    // is ever captured - network recording was entirely inert before.
    this.setInterceptorMode('RECORD');

    if (sessionStartTime) this.onNavigation();

    console.info('[ReplayX Recorder] Recording session', sessionId);
  }

  stop(): StopResult {
    if (!this.recording) return { events: [], startTime: 0, initialState: null };
    this.recording = false;

    document.removeEventListener('click', this.onClickBound, true);
    document.removeEventListener('dblclick', this.onDblClickBound, true);
    document.removeEventListener('input', this.onInputBound, true);
    document.removeEventListener('change', this.onChangeBound, true);
    document.removeEventListener('submit', this.onSubmitBound, true);
    document.removeEventListener('scroll', this.onScrollBound, true);
    document.removeEventListener('focus', this.onFocusBound, true);
    document.removeEventListener('blur', this.onBlurBound, true);
    document.removeEventListener('keydown', this.onKeyDownBound, true);
    document.removeEventListener('keyup', this.onKeyUpBound, true);
    window.removeEventListener('resize', this.onResizeBound);

    this.cleanupNavigationTracking();
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;

    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    this.pendingScroll = null;

    this.setInterceptorMode('IDLE');

    const result: StopResult = {
      events: this.events,
      startTime: this.sessionStartTime,
      initialState: this.initialState,
    };
    this.events = [];
    this.initialState = null;
    this.approxSessionBytes = 0;
    console.info('[ReplayX Recorder] Stopped; captured', result.events.length, 'events');
    return result;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isRecordingActive(): boolean {
    return this.recording;
  }

  isPausedState(): boolean {
    return this.paused;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionStartTime(): number {
    return this.sessionStartTime;
  }

  addEvent(event: RecordedEvent | null | undefined): void {
    if (!event || typeof event !== 'object' || !event.type) return;
    if (!this.recording || this.paused || this.limitReached) return;
    // Never record what the replayer is driving.
    if ((window as unknown as Record<string, unknown>)._replayx_is_replaying) return;

    if (this.events.length >= this.limits.maxEvents) {
      this.onLimitReached('event count');
      return;
    }

    // A cheap size estimate. `JSON.stringify(event).length` per event (the
    // previous approach) is O(payload) on the hot path and doubles the cost of
    // every large mutation record.
    const estimatedBytes = estimatePayloadBytes(event);
    if (this.approxSessionBytes + estimatedBytes > this.limits.maxSessionBytes) {
      this.onLimitReached('session size');
      return;
    }

    this.sequenceCounter += 1;
    event.sequence = this.sequenceCounter;
    event.payload.frameUrl = window.location.href;
    this.events.push(event);
    this.approxSessionBytes += estimatedBytes;

    if (this.events.length >= this.limits.flushThreshold) this.flushEventsToBackground();
  }

  /** Hands buffered events to the background and clears the local buffer. */
  flushEventsToBackground(): void {
    if (this.events.length === 0) return;
    const events = this.flushEvents();
    try {
      chrome.runtime.sendMessage(
        { action: 'SAVE_RECORDING_EVENTS', sessionId: this.sessionId, events },
        () => {
          if (chrome.runtime.lastError) {
            console.warn('[ReplayX Recorder] Flush failed:', chrome.runtime.lastError.message);
          }
        },
      );
    } catch (error) {
      console.warn('[ReplayX Recorder] Flush threw:', error);
    }
  }

  flushEvents(): RecordedEvent[] {
    const flushed = this.events;
    this.events = [];
    return flushed;
  }

  // -------------------------------------------------------------------------
  // Capture handlers
  // -------------------------------------------------------------------------

  private onClick(e: MouseEvent, isDouble: boolean): void {
    const target = this.resolveTarget(e);
    if (!target) return;
    this.addEvent({
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: this.timestamp(),
      type: isDouble ? 'DoubleClick' : 'Click',
      payload: { ...this.target(target), x: e.clientX, y: e.clientY, ...(isDouble ? { dbl: true } : {}) },
    } as RecordedEvent);
  }

  private onInput(e: Event): void {
    const now = Date.now();
    if (now - this.lastInputAt < INPUT_DEBOUNCE_MS) return;
    this.lastInputAt = now;

    const target = this.resolveTarget(e);
    if (!target) return;
    const { value, masked } = this.readValue(target);

    this.addEvent({
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: this.timestamp(),
      type: 'Input',
      payload: {
        ...this.target(target),
        value,
        masked,
        inputType: (e as globalThis.InputEvent).inputType || inputElementType(target) || 'unknown',
      },
    } as RecordedEvent);
  }

  private onChange(e: Event): void {
    const target = this.resolveTarget(e);
    if (!target) return;
    // Change events were previously stored unmasked, leaking password fields
    // that the Input handler had carefully redacted.
    const { value, masked } = this.readValue(target);

    this.addEvent({
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: this.timestamp(),
      type: 'Change',
      payload: { ...this.target(target), value, masked, inputType: inputElementType(target) || 'unknown' },
    } as RecordedEvent);
  }

  private onSubmit(e: Event): void {
    const target = this.resolveTarget(e);
    const form = target?.closest('form') as HTMLFormElement | null;
    if (!form) return;
    this.addEvent({
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: this.timestamp(),
      type: 'Submit',
      payload: {
        ...this.target(form),
        formAction: form.getAttribute('action') || undefined,
        formMethod: form.getAttribute('method') || undefined,
      },
    } as RecordedEvent);
  }

  private onKey(e: KeyboardEvent, kind: 'down' | 'up'): void {
    if (e.repeat && kind === 'down') return;
    if (isReplayXNode(e.target as Node)) return;
    this.addEvent({
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: this.timestamp(),
      type: 'Key',
      payload: {
        // Recording both edges without a discriminator made replay fire every
        // key twice.
        kind,
        key: e.key,
        code: e.code,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
      },
    } as RecordedEvent);
  }

  /**
   * Trailing-edge debounce. The previous logic combined a leading rate limit
   * with a trailing timer, so it recorded where the scroll *started* and threw
   * away where it ended - which is the only position replay cares about.
   */
  private onScroll(e: Event): void {
    const isDocument = e.target === document || e.target === document.scrollingElement;
    const element = isDocument ? null : (e.target as Element | null);
    if (element && isReplayXNode(element)) return;

    this.pendingScroll = {
      target: element ?? window,
      selector: element ? getRobustSelector(element) : 'window',
    };

    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      const pending = this.pendingScroll;
      this.pendingScroll = null;
      if (!pending) return;

      const isWindow = pending.target === window;
      const el = isWindow ? null : (pending.target as Element);
      this.addEvent({
        id: generateId(),
        sessionId: this.sessionId,
        timestamp: this.timestamp(),
        type: 'Scroll',
        payload: {
          selector: pending.selector,
          scrollTop: isWindow ? window.scrollY : (el?.scrollTop ?? 0),
          scrollLeft: isWindow ? window.scrollX : (el?.scrollLeft ?? 0),
        },
      } as RecordedEvent);
    }, SCROLL_DEBOUNCE_MS);
  }

  private onResize(): void {
    this.addEvent({
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: this.timestamp(),
      type: 'Resize',
      payload: { width: window.innerWidth, height: window.innerHeight },
    } as RecordedEvent);
  }

  private onFocusChange(e: Event, type: 'Focus' | 'Blur'): void {
    const target = this.resolveTarget(e);
    if (!target) return;
    this.addEvent({
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: this.timestamp(),
      type,
      payload: this.target(target),
    } as RecordedEvent);
  }

  private onNavigation(e?: Event): void {
    this.addEvent({
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: this.timestamp(),
      type: 'Navigation',
      payload: {
        url: window.location.href,
        referrer: document.referrer,
        navigationType: this.navigationType(e),
      },
    } as RecordedEvent);
  }

  private navigationType(e?: Event): 'navigate' | 'push' | 'replace' | 'back' | 'forward' {
    if (e?.type === 'popstate') {
      const current = window.history.length;
      const previous = this.historyLength;
      this.historyLength = current;
      if (current < previous) return 'back';
      if (current > previous) return 'forward';
      return 'navigate';
    }
    if (e?.type === 'pushstate') return 'push';
    if (e?.type === 'replacestate') return 'replace';
    return 'navigate';
  }

  // -------------------------------------------------------------------------
  // Infrastructure
  // -------------------------------------------------------------------------

  private setupNavigationTracking(): void {
    window.addEventListener('popstate', this.onNavigationBound);
    window.addEventListener('hashchange', this.onNavigationBound);

    const patched = history.pushState as History['pushState'] & { _replayxPatched?: boolean };
    // The old guard returned *before* stashing the originals, so cleanup could
    // never restore them and the patch leaked for the life of the page.
    if (patched._replayxPatched) return;

    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    this.originalPushState = originalPush;
    this.originalReplaceState = originalReplace;

    const pushState: History['pushState'] = (...args) => {
      originalPush.apply(history, args);
      this.onNavigation({ type: 'pushstate' } as Event);
    };
    const replaceState: History['replaceState'] = (...args) => {
      originalReplace.apply(history, args);
      this.onNavigation({ type: 'replacestate' } as Event);
    };

    (pushState as typeof patched)._replayxPatched = true;
    history.pushState = pushState;
    history.replaceState = replaceState;
  }

  private cleanupNavigationTracking(): void {
    window.removeEventListener('popstate', this.onNavigationBound);
    window.removeEventListener('hashchange', this.onNavigationBound);
    if (this.originalPushState) history.pushState = this.originalPushState;
    if (this.originalReplaceState) history.replaceState = this.originalReplaceState;
    this.originalPushState = null;
    this.originalReplaceState = null;
  }

  private setupMutationObserver(): void {
    if (!document.body || typeof MutationObserver === 'undefined') return;

    this.mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target = mutation.target as Element;
        // Our own widget and replay cursor must not pollute the recording.
        if (isReplayXNode(target)) continue;
        if (!this.allowMutation()) return;

        const payload = this.describeMutation(mutation, target);
        if (!payload) continue;

        this.addEvent({
          id: generateId(),
          sessionId: this.sessionId,
          timestamp: this.timestamp(),
          type: 'Mutation',
          payload,
        } as RecordedEvent);
      }
    });

    this.mutationObserver.observe(document.body, {
      childList: true,
      attributes: true,
      characterData: true,
      subtree: true,
      attributeOldValue: true,
      characterDataOldValue: true,
    });
  }

  private describeMutation(mutation: MutationRecord, target: Element): MutationPayload | null {
    const targetSelector = target.nodeType === Node.ELEMENT_NODE ? getRobustSelector(target) : '';

    if (mutation.type === 'childList') {
      const serialise = (nodes: NodeList) =>
        Array.from(nodes)
          .filter((node) => !isReplayXNode(node))
          .map((node) =>
            node.nodeType === Node.ELEMENT_NODE
              ? (node as Element).outerHTML.slice(0, this.limits.maxMutationHtml)
              : (node.textContent || '').slice(0, this.limits.maxMutationHtml),
          );
      const addedNodes = serialise(mutation.addedNodes);
      const removedNodes = serialise(mutation.removedNodes);
      if (addedNodes.length === 0 && removedNodes.length === 0) return null;
      return { type: 'childList', targetSelector, addedNodes, removedNodes };
    }

    if (mutation.type === 'attributes') {
      const attributeName = mutation.attributeName || '';
      if (attributeName.startsWith('data-replayx')) return null;
      return {
        type: 'attributes',
        targetSelector,
        attributeName,
        attributeValue: (target.getAttribute(attributeName) || '').slice(0, this.limits.maxMutationHtml),
        oldValue: (mutation.oldValue || '').slice(0, this.limits.maxMutationHtml),
      };
    }

    if (mutation.type === 'characterData') {
      return {
        type: 'characterData',
        targetSelector,
        oldValue: (mutation.oldValue || '').slice(0, this.limits.maxMutationHtml),
        newValue: (mutation.target.textContent || '').slice(0, this.limits.maxMutationHtml),
      };
    }

    return null;
  }

  /** Sliding one-second budget so an animation loop cannot fill the session. */
  private allowMutation(): boolean {
    const now = Date.now();
    if (now - this.mutationWindowStart >= 1000) {
      this.mutationWindowStart = now;
      this.mutationsInWindow = 0;
    }
    this.mutationsInWindow += 1;
    return this.mutationsInWindow <= this.limits.maxMutationsPerSecond;
  }

  private onLimitReached(reason: string): void {
    if (this.limitReached) return;
    this.limitReached = true;
    console.warn(`[ReplayX Recorder] ${reason} limit reached; no further events will be captured`);
    // Deliberately *not* calling stop(): stop() is the caller's transition and
    // invoking it from inside addEvent tore down listeners mid-dispatch and
    // discarded the events it had just flushed.
    this.flushEventsToBackground();
  }

  private resolveTarget(e: Event): Element | null {
    const raw = (e.composedPath?.()[0] as Node | undefined) ?? (e.target as Node | null);
    const element =
      raw && raw.nodeType === Node.ELEMENT_NODE ? (raw as Element) : ((raw?.parentElement as Element) ?? null);
    if (!element || isReplayXNode(element)) return null;
    return element;
  }

  private target(el: Element): TargetPayload {
    return buildTargetPayload(el);
  }

  private isSensitive(el: Element): boolean {
    const type = inputElementType(el);
    if (type === 'checkbox' || type === 'radio') return false;
    if (type === 'password') return true;
    if (el.hasAttribute('data-replay-mask')) return true;
    if (el.getAttribute('autocomplete')?.match(/password|cc-|one-time-code/i)) return true;
    const name = `${el.getAttribute('name') ?? ''} ${el.getAttribute('id') ?? ''}`;
    return SENSITIVE_NAME.test(name);
  }

  private readValue(el: Element): { value: string; masked: boolean } {
    const type = inputElementType(el);
    if (type === 'checkbox' || type === 'radio') {
      return { value: String((el as HTMLInputElement).checked), masked: false };
    }
    if (this.isSensitive(el)) return { value: '********', masked: true };
    if (el.hasAttribute('contenteditable')) {
      return { value: (el as HTMLElement).innerText ?? '', masked: false };
    }
    const value = (el as HTMLInputElement).value;
    return { value: typeof value === 'string' ? value : '', masked: false };
  }

  private timestamp(): number {
    return Date.now() - this.sessionStartTime;
  }

  private captureStorage(get: () => Storage): Record<string, string> {
    const data: Record<string, string> = {};
    try {
      const storage = get();
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key !== null) data[key] = storage.getItem(key) ?? '';
      }
    } catch {
      // Storage access throws on opaque origins and when cookies are blocked.
    }
    return data;
  }

  private safeCookies(): string | undefined {
    try {
      return document.cookie || undefined;
    } catch {
      return undefined;
    }
  }

  private setInterceptorMode(mode: InterceptorMode): void {
    try {
      window.postMessage({ source: CONTENT_SOURCE, action: 'SET_MODE', mode }, '*');
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inputElementType(el: Element): string | null {
  const type = (el as HTMLInputElement).type;
  return typeof type === 'string' ? type.toLowerCase() : null;
}

export function generateId(): string {
  // crypto.randomUUID is unavailable on insecure origins.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Approximate byte cost without serialising the whole event. Only string
 * payload fields are measured, which dominates real payload size.
 */
export function estimatePayloadBytes(event: RecordedEvent): number {
  let bytes = 96; // envelope overhead
  const payload = event.payload as unknown as Record<string, unknown>;
  for (const value of Object.values(payload)) {
    if (typeof value === 'string') bytes += value.length;
    else if (Array.isArray(value)) {
      for (const entry of value) bytes += typeof entry === 'string' ? entry.length : 8;
    } else bytes += 8;
  }
  return bytes;
}
