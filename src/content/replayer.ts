import {
  CONTENT_SOURCE,
  isInterceptorMessage,
  type InterceptorMode,
  type NetworkMock,
} from '../messages';
import type {
  BlurPayload,
  ChangePayload,
  ClickPayload,
  FocusPayload,
  InputPayload,
  KeyPayload,
  NavigationPayload,
  NetworkPayload,
  RecordedEvent,
  ReplayErrorEntry,
  ReplayState,
  ScrollPayload,
  SessionData,
  SubmitPayload,
  TargetPayload,
} from '../types';
import { REPLAYX_UI_ATTR } from './selector';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const FIND_TIMEOUT_MS = 3000;
/** Loop cadence floor: `delayMs` divides by speed, so 16ms at 10x is a busy loop. */
const MIN_TICK_MS = 8;
/** A mutation recorded within this window of an interaction is attributed to it. */
const MUTATION_ATTRIBUTION_MS = 1500;

export interface ReplayOptions {
  speed?: number;
  isResume?: boolean;
  resumeIndex?: number;
}

interface QueueItem {
  event: RecordedEvent;
  scheduledTime: number;
  executed: boolean;
}

/** A cheap structural signature; `document.body.innerHTML` serialises the whole tree. */
export interface DomFingerprint {
  elements: number;
  textLength: number;
  structure: number;
}

export class Replayer {
  private replaying = false;
  private state: ReplayState = { isPlaying: false, currentTime: 0, speed: 1, paused: false };

  private eventQueue: QueueItem[] = [];
  private nextEventIndex = 0;
  private startIndex = 0;

  private cursor: HTMLElement | null = null;
  private replayStartTime = 0;
  private session: SessionData | null = null;

  private pendingNetworkRequests = 0;
  private lastNetworkActivityAt = 0;
  private lastDomMutationAt = 0;
  private domMutationCount = 0;
  private domStabilityObserver: MutationObserver | null = null;

  /** Event ids the *recording* observed a DOM change after. */
  private eventsExpectingDomChange = new Set<string>();

  private replayErrors: ReplayErrorEntry[] = [];
  private retryCount = new Map<string, number>();

  public onStop?: () => void;

  private readonly onUnload = () => this.stop(false);
  private readonly onKeyboardControl = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      if (this.state.paused) this.resume();
      else this.pause();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.stop(false);
    }
  };
  private readonly onInterceptorMessage = (event: MessageEvent) => {
    if (event.source !== window || !isInterceptorMessage(event.data)) return;
    switch (event.data.action) {
      case 'NETWORK_REQUEST_STARTED':
        this.pendingNetworkRequests += 1;
        this.lastNetworkActivityAt = performance.now();
        break;
      case 'NETWORK_REQUEST_FINISHED':
      case 'NETWORK_REQUEST_FAILED':
        this.pendingNetworkRequests = Math.max(0, this.pendingNetworkRequests - 1);
        this.lastNetworkActivityAt = performance.now();
        break;
      case 'MOCK_CONSUMED':
        this.lastNetworkActivityAt = performance.now();
        break;
    }
  };

  async start(session: SessionData, options: ReplayOptions = {}): Promise<void> {
    if (this.replaying) return;
    this.replaying = true;
    this.session = session;
    this.state.speed = clampSpeed(options.speed ?? 1);
    this.state.paused = false;
    this.replayStartTime = performance.now();
    this.replayErrors = [];
    this.retryCount.clear();
    (window as unknown as Record<string, unknown>)._replayx_is_replaying = true;

    const isResuming = options.isResume || readSession('replayx_active') === 'true';
    const isSessionStartPage = normalizeUrl(window.location.href) === normalizeUrl(session.url);

    if (!isResuming) writeSession('replayx_event_index', '0');

    if (session.initialState && !isResuming && isSessionStartPage) {
      this.restoreInitialState(session);
      return; // restoreInitialState reloads the page
    }

    if (!readSession('replayx_active')) writeSession('replayx_active', 'true');

    this.pendingNetworkRequests = 0;
    this.lastNetworkActivityAt = performance.now();
    this.lastDomMutationAt = performance.now();
    this.domMutationCount = 0;
    this.indexExpectedMutations(session.events);
    this.setupDomStabilityObserver();

    this.setInterceptorMode('REPLAY', collectNetworkMocks(session.events));
    window.addEventListener('message', this.onInterceptorMessage);
    window.addEventListener('beforeunload', this.onUnload);
    document.addEventListener('keydown', this.onKeyboardControl);

    this.createCursor();
    this.scheduleEvents(session.events, options.resumeIndex);

    this.state.isPlaying = true;
    void this.replayLoop();
  }

  stop(isFinished = false): void {
    if (!this.replaying) return;
    this.replaying = false;
    this.state.isPlaying = false;
    this.eventQueue = [];
    (window as unknown as Record<string, unknown>)._replayx_is_replaying = false;

    // Previously stop() rewrote itself with a wrapper on every start(), so each
    // record/replay cycle nested another closure and leaked the old listeners.
    window.removeEventListener('beforeunload', this.onUnload);
    window.removeEventListener('message', this.onInterceptorMessage);
    document.removeEventListener('keydown', this.onKeyboardControl);

    this.disconnectDomStabilityObserver();
    this.retryCount.clear();
    this.cursor?.remove();
    this.cursor = null;
    this.setInterceptorMode('IDLE');

    if (isFinished) {
      removeSession('replayx_active');
      removeSession('replayx_event_index');
      this.notifyFinished();
    }

    this.onStop?.();
    console.info('[ReplayX Replayer] Replay stopped');
  }

  pause(): void {
    this.state.paused = true;
  }

  resume(): void {
    this.state.paused = false;
  }

  setSpeed(speed: number): void {
    this.state.speed = clampSpeed(speed);
    if (this.cursor) this.cursor.style.transition = `all ${0.2 / this.state.speed}s ease-out`;
  }

  isActive(): boolean {
    return this.replaying;
  }

  getErrors(): ReplayErrorEntry[] {
    return this.replayErrors;
  }

  getProgress(): { index: number; total: number } {
    return { index: this.startIndex + this.nextEventIndex, total: this.startIndex + this.eventQueue.length };
  }

  /** Human-scale pauses between synthetic interactions, scaled by replay speed. */
  private delayMs(ms: number): Promise<void> {
    return sleep(ms / this.state.speed);
  }

  async step(): Promise<void> {
    if (!this.replaying) return;
    const item = this.eventQueue[this.nextEventIndex];
    if (!item) return;

    try {
      const navigated = await this.executeEvent(item.event);
      item.executed = true;
      this.nextEventIndex += 1;
      this.commitProgress();
      this.pause();
      if (navigated) this.stop(false);
    } catch (error) {
      this.nextEventIndex += 1;
      this.recordError(item.event, 'step_failed', 'Replay step failed', errorMessage(error), 'step');
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private scheduleEvents(events: RecordedEvent[], resumeIndex?: number): void {
    // An explicit resume index is a caller instruction and must win over the
    // page-local checkpoint, which the previous ordering ignored entirely.
    if (typeof resumeIndex === 'number' && resumeIndex > 0) {
      this.startIndex = resumeIndex;
    } else {
      const saved = readSession('replayx_event_index');
      const parsed = saved === null ? Number.NaN : Number.parseInt(saved, 10);
      this.startIndex = Number.isFinite(parsed) && parsed > 0 ? parsed : this.findResumeIndex(events);
    }
    this.startIndex = Math.min(Math.max(this.startIndex, 0), events.length);

    const slice = events.slice(this.startIndex);
    const offset = slice[0]?.timestamp ?? 0;

    this.eventQueue = slice
      .map((event, index) => ({
        event,
        scheduledTime: Math.max(0, event.timestamp - offset),
        executed: false,
        order: index,
      }))
      // Recording order is the tie-break; a bare sort by time reorders events
      // that share a millisecond, which for input/submit pairs is fatal.
      .sort((a, b) => a.scheduledTime - b.scheduledTime || a.order - b.order)
      .map(({ event, scheduledTime, executed }) => ({ event, scheduledTime, executed }));

    this.nextEventIndex = 0;
    console.info(`[ReplayX Replayer] Scheduled ${this.eventQueue.length} events from index ${this.startIndex}`);
  }

  private findResumeIndex(events: RecordedEvent[]): number {
    const current = normalizeUrl(window.location.href);
    for (let i = 0; i < events.length; i++) {
      const frameUrl = events[i]?.payload?.frameUrl;
      if (frameUrl && normalizeUrl(frameUrl) === current) return i;
    }
    return 0;
  }

  /**
   * Records which interactions were followed by a DOM mutation during the
   * original recording. Only those are eligible for a "no DOM change" finding.
   */
  private indexExpectedMutations(events: RecordedEvent[]): void {
    this.eventsExpectingDomChange.clear();
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!event || !isInteraction(event.type)) continue;
      for (let j = i + 1; j < events.length; j++) {
        const next = events[j];
        if (!next) break;
        if (next.timestamp - event.timestamp > MUTATION_ATTRIBUTION_MS) break;
        if (next.type === 'Mutation' || next.type === 'Navigation') {
          this.eventsExpectingDomChange.add(event.id);
          break;
        }
      }
    }
  }

  private commitProgress(): void {
    const progressIndex = this.startIndex + this.nextEventIndex;
    writeSession('replayx_event_index', String(progressIndex));
    if (!this.session || typeof chrome === 'undefined' || !chrome.runtime?.id) return;
    try {
      chrome.runtime.sendMessage(
        { action: 'UPDATE_REPLAY_PROGRESS', sessionId: this.session.id, progressIndex },
        () => void chrome.runtime.lastError,
      );
    } catch {
      /* the extension context can disappear mid-replay */
    }
  }

  private async replayLoop(): Promise<void> {
    while (this.replaying && this.state.isPlaying) {
      if (this.state.paused) {
        await sleep(100);
        continue;
      }

      const currentTime = (performance.now() - this.replayStartTime) * this.state.speed;
      this.state.currentTime = currentTime;

      while (this.nextEventIndex < this.eventQueue.length) {
        const item = this.eventQueue[this.nextEventIndex];
        if (!item || item.executed || item.scheduledTime > currentTime) break;

        if (!this.belongsToThisFrame(item.event)) {
          item.executed = true;
          this.nextEventIndex += 1;
          continue;
        }

        try {
          const navigated = await this.executeEvent(item.event);
          item.executed = true;
          this.nextEventIndex += 1;
          this.commitProgress();
          if (navigated) {
            this.stop(false); // keep the background session alive across the load
            return;
          }
        } catch (error) {
          this.nextEventIndex += 1;
          // executeEvent has already recorded the failure; re-recording here
          // produced two entries per failure in the debugger.
          console.warn('[ReplayX Replayer] Event failed:', item.event.type, errorMessage(error));
        }
      }

      if (this.nextEventIndex >= this.eventQueue.length) {
        this.stop(true);
        return;
      }

      await sleep(Math.max(MIN_TICK_MS, 16 / this.state.speed));
    }
  }

  private belongsToThisFrame(event: RecordedEvent): boolean {
    const frameUrl = event.payload?.frameUrl;
    if (!frameUrl) return true;
    return normalizeUrl(frameUrl) === normalizeUrl(window.location.href);
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  private async executeEvent(event: RecordedEvent): Promise<boolean> {
    try {
      let navigated: boolean | void;
      switch (event.type) {
        case 'Click':
        case 'DoubleClick':
          navigated = await this.withRetry(event, () => this.executeClick(event));
          break;
        case 'Input':
          navigated = await this.withRetry(event, () => this.executeInput(event));
          break;
        case 'Change':
          navigated = await this.executeChange(event);
          break;
        case 'Submit':
          navigated = await this.withRetry(event, () => this.executeSubmit(event));
          break;
        case 'Key':
          navigated = await this.executeKey(event);
          break;
        case 'Scroll':
          navigated = await this.executeScroll(event);
          break;
        case 'Navigation':
          navigated = await this.executeNavigation(event);
          break;
        case 'Focus':
        case 'Blur':
          navigated = await this.executeFocusChange(event);
          break;
        // Mutations, resizes and network events are outcomes of replay, not
        // inputs to it; replaying them would fight the page.
        case 'Mutation':
        case 'Resize':
        case 'Network':
          navigated = false;
          break;
        default:
          console.warn('[ReplayX Replayer] Unknown event type:', (event as RecordedEvent).type);
          navigated = false;
      }
      this.retryCount.delete(event.id);
      return navigated === true;
    } catch (error) {
      this.recordError(event, 'event_failed', 'Replay event failed', errorMessage(error), 'playback');
      this.retryCount.delete(event.id);
      throw error;
    }
  }

  private async withRetry<T>(event: RecordedEvent, run: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await run();
      } catch (error) {
        const attempts = this.retryCount.get(event.id) ?? 0;
        if (attempts >= MAX_RETRIES) throw error;
        this.retryCount.set(event.id, attempts + 1);
        console.info(`[ReplayX Replayer] Retry ${attempts + 1}/${MAX_RETRIES} for ${event.type}`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  private async executeClick(event: RecordedEvent): Promise<boolean> {
    if (event.type !== 'Click' && event.type !== 'DoubleClick') return false;
    const payload = event.payload as ClickPayload;
    const element = await this.findElement(payload);
    if (!element) return this.reportMissingTarget(event, payload, 'Click');

    element.scrollIntoView({ behavior: 'auto', block: 'center' });
    await this.delayMs(40);
    this.moveCursorTo(element);
    await this.delayMs(80);

    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: payload.x,
      clientY: payload.y,
      // `view` is deliberately omitted: the native element.click() below is what
      // actually drives default behaviour, and passing a cross-realm window
      // makes the MouseEvent constructor throw.
    };
    element.dispatchEvent(new MouseEvent('mousedown', init));
    element.dispatchEvent(new MouseEvent('mouseup', init));
    element.click();
    if (payload.dbl || event.type === 'DoubleClick') {
      element.dispatchEvent(new MouseEvent('dblclick', init));
    }

    await this.settle(event, 1500, 'interaction');
    return false;
  }

  private async executeInput(event: RecordedEvent): Promise<boolean> {
    if (event.type !== 'Input') return false;
    const payload = event.payload as InputPayload;
    const element = await this.findElement(payload);
    if (!element) return this.reportMissingTarget(event, payload, 'Input');

    element.scrollIntoView({ behavior: 'auto', block: 'center' });
    await this.delayMs(30);
    this.moveCursorTo(element);
    element.focus();
    await this.delayMs(30);

    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
      const checked = payload.value === 'true';
      if (element.checked !== checked) setNativeProp(element, 'checked', checked);
    } else if (element.hasAttribute('contenteditable')) {
      if (element.innerText !== payload.value) {
        element.innerText = payload.value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (isFormControl(element)) {
      if (element.value !== payload.value) {
        element.dispatchEvent(new globalThis.InputEvent('beforeinput', { bubbles: true, data: payload.value }));
        setNativeProp(element, 'value', payload.value);
      }
      await this.settle(event, 1200, 'input');
    }
    return false;
  }

  private async executeChange(event: RecordedEvent): Promise<boolean> {
    if (event.type !== 'Change') return false;
    const payload = event.payload as ChangePayload;
    const element = await this.findElement(payload);
    if (!element) return this.reportMissingTarget(event, payload, 'Change');
    if (isFormControl(element)) setNativeProp(element, 'value', payload.value);
    return false;
  }

  private async executeSubmit(event: RecordedEvent): Promise<boolean> {
    if (event.type !== 'Submit') return false;
    const payload = event.payload as SubmitPayload;
    const element = await this.findElement(payload);
    if (!element) return this.reportMissingTarget(event, payload, 'Submit');

    const form = element instanceof HTMLFormElement ? element : element.closest('form');
    if (!form) return false;

    const accepted = form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    if (accepted) {
      try {
        form.requestSubmit?.();
      } catch {
        /* requestSubmit is unavailable in some embedders */
      }
    }
    await this.settle(event, 1800, 'submit');
    return false;
  }

  private async executeKey(event: RecordedEvent): Promise<boolean> {
    if (event.type !== 'Key') return false;
    const payload = event.payload as KeyPayload;
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    if (!target) return false;

    const init: KeyboardEventInit = {
      key: payload.key,
      code: payload.code,
      altKey: Boolean(payload.altKey),
      ctrlKey: Boolean(payload.ctrlKey),
      metaKey: Boolean(payload.metaKey),
      shiftKey: Boolean(payload.shiftKey),
      bubbles: true,
      cancelable: true,
    };
    // Legacy sessions carry no `kind`; fall back to the old both-edges behaviour.
    const kind = payload.kind;
    if (kind === 'down' || kind === undefined) target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (kind === 'up' || kind === undefined) target.dispatchEvent(new KeyboardEvent('keyup', init));
    return false;
  }

  private async executeScroll(event: RecordedEvent): Promise<boolean> {
    if (event.type !== 'Scroll') return false;
    const payload = event.payload as ScrollPayload;

    if (payload.selector === 'window') {
      window.scrollTo(payload.scrollLeft, payload.scrollTop);
      return false;
    }

    const element = await this.findElement(payload, 800);
    if (!element) return false;
    element.scrollTop = payload.scrollTop;
    element.scrollLeft = payload.scrollLeft;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    return false;
  }

  private async executeNavigation(event: RecordedEvent): Promise<boolean> {
    if (event.type !== 'Navigation') return false;
    const payload = event.payload as NavigationPayload;
    const type = payload.navigationType ?? 'navigate';

    if (type === 'back') {
      window.history.back();
      return true;
    }
    if (type === 'forward') {
      window.history.forward();
      return true;
    }
    // Same normalisation as everywhere else; the old inline variant kept the
    // hash and so re-navigated on every in-page anchor change.
    if (normalizeUrl(window.location.href) === normalizeUrl(payload.url)) return false;

    console.info('[ReplayX Replayer] Navigating to', payload.url);
    window.location.assign(payload.url);
    return true;
  }

  private async executeFocusChange(event: RecordedEvent): Promise<boolean> {
    if (event.type !== 'Focus' && event.type !== 'Blur') return false;
    const payload = event.payload as FocusPayload | BlurPayload;
    const element = await this.findElement(payload, 800);
    if (!element) return false;
    if (event.type === 'Focus') element.focus();
    else element.blur();
    return false;
  }

  private reportMissingTarget(event: RecordedEvent, payload: TargetPayload, label: string): boolean {
    this.recordError(
      event,
      'target_not_found',
      `${label} target was not found`,
      'The recorded selector could not be resolved during replay. The element may have changed, moved, or not yet rendered.',
      'find',
      {
        retryable: true,
        severity: 'error',
        selector: payload.selector,
        targetTag: payload.targetTag,
        expected: 'An element matching the recorded selector',
        actual: 'No matching element could be resolved during replay',
      },
    );
    return false;
  }

  // -------------------------------------------------------------------------
  // Settling and mismatch detection
  // -------------------------------------------------------------------------

  /**
   * Waits for network and DOM quiescence, then judges the outcome once.
   *
   * The previous implementation compared snapshots *inside* the wait loop and
   * flagged a mismatch whenever the DOM had not yet changed - which on the
   * first 50ms tick is true for essentially every interaction. That both
   * flooded the report with false positives and aborted settling immediately,
   * defeating the whole purpose of the wait.
   */
  private async settle(event: RecordedEvent, timeoutMs: number, kind: string): Promise<void> {
    const before = this.fingerprint();
    const deadline = performance.now() + timeoutMs;

    while (performance.now() < deadline) {
      await sleep(50);
      const networkIdle =
        this.pendingNetworkRequests <= 0 && performance.now() - this.lastNetworkActivityAt > 120;
      const domIdle = performance.now() - this.lastDomMutationAt > 120;
      if (document.readyState === 'complete' && networkIdle && domIdle) break;
    }

    if (kind === 'navigation') return;
    // Only interactions the *recording* showed producing a DOM change can
    // meaningfully be reported as producing none.
    if (!this.eventsExpectingDomChange.has(event.id)) return;

    const after = this.fingerprint();
    if (!fingerprintsDiffer(before, after)) {
      this.recordError(
        event,
        'dom_mismatch',
        'Replay produced no observable DOM change after the interaction.',
        `The original recording showed the DOM updating after this ${kind}, but replay left it unchanged.`,
        'settle',
        {
          retryable: true,
          severity: 'warning',
          expected: 'A DOM transition matching the recorded session',
          actual: `DOM unchanged (${after.elements} elements, ${after.textLength} chars of text)`,
        },
      );
    }
  }

  /** O(nodes) with no string allocation, unlike serialising `document.body.innerHTML`. */
  fingerprint(): DomFingerprint {
    const body = document.body;
    if (!body) return { elements: 0, textLength: 0, structure: 0 };

    let elements = 0;
    let structure = 0;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode() as Element | null;
    while (node) {
      if (!node.hasAttribute(REPLAYX_UI_ATTR)) {
        elements += 1;
        // Cheap order-sensitive rolling hash of the tag sequence.
        structure = (structure * 31 + node.tagName.length + node.childElementCount) >>> 0;
      }
      node = walker.nextNode() as Element | null;
    }

    return { elements, textLength: (body.textContent ?? '').length, structure };
  }

  private setupDomStabilityObserver(): void {
    if (this.domStabilityObserver || !document.body || typeof MutationObserver === 'undefined') return;
    this.domStabilityObserver = new MutationObserver((mutations) => {
      // Our own cursor moves constantly; counting it would make the DOM look
      // permanently unstable and every settle would run to timeout.
      if (mutations.every((m) => (m.target as Element)?.closest?.(`[${REPLAYX_UI_ATTR}]`))) return;
      this.domMutationCount += mutations.length;
      this.lastDomMutationAt = performance.now();
    });
    this.domStabilityObserver.observe(document.body, {
      childList: true,
      attributes: true,
      characterData: true,
      subtree: true,
    });
  }

  private disconnectDomStabilityObserver(): void {
    this.domStabilityObserver?.disconnect();
    this.domStabilityObserver = null;
  }

  // -------------------------------------------------------------------------
  // Element resolution
  // -------------------------------------------------------------------------

  private async findElement(target: TargetPayload, timeoutMs = FIND_TIMEOUT_MS): Promise<HTMLElement | null> {
    const candidates = buildCandidates(target);
    const deadline = performance.now() + timeoutMs;
    let delay = 25;

    for (;;) {
      const found = this.resolveCandidates(candidates, target.textSnippet);
      if (found) return found;
      if (performance.now() >= deadline) return null;
      await sleep(delay);
      // Back off instead of hammering a 100ms poll for the full timeout.
      delay = Math.min(delay * 2, 250);
    }
  }

  private resolveCandidates(candidates: string[], textSnippet?: string): HTMLElement | null {
    for (const selector of candidates) {
      const element = this.querySelectorDeep(selector);
      if (element && this.isUsable(element)) return element;
    }
    if (textSnippet) {
      const byText = this.findByText(textSnippet);
      if (byText) return byText;
    }
    return null;
  }

  /**
   * Light DOM first, shadow roots only if the page actually has any. The
   * previous version walked every element in the document on every attempt,
   * for every candidate selector - O(candidates x nodes) per 100ms tick.
   */
  private querySelectorDeep(selector: string, root: ParentNode = document): HTMLElement | null {
    let direct: Element | null = null;
    try {
      direct = root.querySelector(selector);
    } catch {
      return null; // malformed selector recorded by an older build
    }
    if (direct) return direct as HTMLElement;

    const hosts = root.querySelectorAll('*');
    for (let i = 0; i < hosts.length; i++) {
      const shadow = (hosts[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (!shadow) continue;
      const found = this.querySelectorDeep(selector, shadow);
      if (found) return found;
    }
    return null;
  }

  private findByText(snippet: string): HTMLElement | null {
    const needle = snippet.trim().slice(0, 120);
    if (!needle) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode() as HTMLElement | null;
    while (node) {
      if (
        !node.hasAttribute(REPLAYX_UI_ATTR) &&
        node.childElementCount === 0 &&
        (node.textContent ?? '').trim().includes(needle) &&
        this.isUsable(node)
      ) {
        return node;
      }
      node = walker.nextNode() as HTMLElement | null;
    }
    return null;
  }

  private isUsable(element: HTMLElement): boolean {
    if (element.hasAttribute(REPLAYX_UI_ATTR)) return false;
    // Form controls are actionable even when visually collapsed.
    if (element.matches('input, textarea, select, form, option')) return true;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // -------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------

  private restoreInitialState(session: SessionData): void {
    const initial = session.initialState;
    if (!initial) return;
    console.info('[ReplayX Replayer] Restoring recorded storage before reload');

    restoreStorage(() => localStorage, initial.localStorage);
    restoreStorage(() => sessionStorage, initial.sessionStorage);

    writeSession('replayx_active', 'true');
    writeSession('replayx_event_index', '0');
    window.location.reload();
  }

  private createCursor(): void {
    if (this.cursor || !document.body) return;
    const cursor = document.createElement('div');
    cursor.setAttribute(REPLAYX_UI_ATTR, 'cursor');
    Object.assign(cursor.style, {
      position: 'fixed',
      width: '20px',
      height: '20px',
      borderRadius: '50%',
      backgroundColor: 'rgba(255, 0, 0, 0.8)',
      border: '2px solid #ff0000',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transition: `all ${0.2 / this.state.speed}s ease-out`,
      boxShadow: '0 0 10px rgba(255, 0, 0, 0.5)',
    });
    document.body.appendChild(cursor);
    this.cursor = cursor;
  }

  private moveCursorTo(element: HTMLElement): void {
    if (!this.cursor) return;
    const rect = element.getBoundingClientRect();
    this.cursor.style.left = `${rect.left + rect.width / 2 - 10}px`;
    this.cursor.style.top = `${rect.top + rect.height / 2 - 10}px`;
  }

  private setInterceptorMode(mode: InterceptorMode, networkEvents?: NetworkMock[]): void {
    try {
      window.postMessage({ source: CONTENT_SOURCE, action: 'SET_MODE', mode, networkEvents }, '*');
    } catch {
      /* ignore */
    }
  }

  private notifyFinished(): void {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    try {
      chrome.runtime.sendMessage({ action: 'REPLAY_FINISHED', errors: this.replayErrors }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[ReplayX Replayer] REPLAY_FINISHED failed:', chrome.runtime.lastError.message);
        }
      });
    } catch (error) {
      console.warn('[ReplayX Replayer] Could not notify background:', error);
    }
  }

  private recordError(
    event: RecordedEvent,
    code: string,
    message: string,
    details: string | undefined,
    stage: string,
    context: Partial<ReplayErrorEntry> = {},
  ): void {
    this.replayErrors.push({
      eventId: event.id,
      eventType: event.type,
      code,
      message,
      details,
      stage,
      timestamp: Date.now(),
      retryable: context.retryable ?? false,
      severity: context.severity ?? 'warning',
      selector: context.selector,
      targetTag: context.targetTag,
      expected: context.expected,
      actual: context.actual,
    });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function normalizeUrl(url: string): string {
  if (!url) return '';
  const withoutHash = url.split('#')[0] ?? url;
  return withoutHash.replace(/\/+$/, '').toLowerCase();
}

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.max(0.1, Math.min(10, speed));
}

export function fingerprintsDiffer(a: DomFingerprint, b: DomFingerprint): boolean {
  return a.elements !== b.elements || a.textLength !== b.textLength || a.structure !== b.structure;
}

export function buildCandidates(target: TargetPayload): string[] {
  const candidates: string[] = [];
  const push = (selector?: string | null) => {
    if (selector && !candidates.includes(selector)) candidates.push(selector);
  };

  push(target.selector);
  for (const fallback of target.fallbackSelectors ?? []) push(fallback);
  if (target.dataTestId) {
    push(`[data-testid="${target.dataTestId}"]`);
    push(`[data-cy="${target.dataTestId}"]`);
    push(`[data-test="${target.dataTestId}"]`);
    push(`[data-qa="${target.dataTestId}"]`);
  }
  if (target.name) {
    push(`${target.targetTag ?? '*'}[name="${target.name}"]`);
    push(`[name="${target.name}"]`);
  }
  if (target.id) push(`#${target.id}`);

  return candidates;
}

export function collectNetworkMocks(events: RecordedEvent[]): NetworkMock[] {
  const mocks: NetworkMock[] = [];
  for (const event of events) {
    if (event.type !== 'Network') continue;
    const payload = event.payload as NetworkPayload;
    mocks.push({
      id: event.id,
      method: payload.method,
      url: payload.url,
      requestBody: payload.requestBody,
      responseStatus: payload.responseStatus,
      responseHeaders: payload.responseHeaders ?? {},
      responseBody: payload.responseBody ?? '',
    });
  }
  return mocks;
}

function isInteraction(type: RecordedEvent['type']): boolean {
  return type === 'Click' || type === 'DoubleClick' || type === 'Input' || type === 'Submit' || type === 'Change';
}

function isFormControl(
  element: Element,
): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  );
}

/** Bypasses React/Vue value setter interception so frameworks observe the change. */
function setNativeProp(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  prop: 'value' | 'checked',
  value: string | boolean,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), prop);
  if (descriptor?.set) descriptor.set.call(element, value);
  else (element as unknown as Record<string, unknown>)[prop] = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function restoreStorage(get: () => Storage, values: Record<string, string> | undefined): void {
  if (!values) return;
  try {
    const storage = get();
    // Only recorded keys are touched, so unrelated user data survives.
    for (const key of Object.keys(values)) storage.removeItem(key);
    for (const [key, value] of Object.entries(values)) storage.setItem(key, value);
  } catch (error) {
    console.warn('[ReplayX Replayer] Storage restore failed:', error);
  }
}

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable on opaque origins */
  }
}

function removeSession(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
