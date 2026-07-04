import { SessionData, RecordedEvent, ReplayState, ClickPayload, InputPayload, ChangePayload, SubmitPayload, ScrollPayload, MutationPayload, NavigationPayload, FocusPayload, BlurPayload } from '../types';

export class Replayer {
  private isReplaying = false;
  private state: ReplayState = {
    isPlaying: false,
    currentTime: 0,
    speed: 1,
    paused: false
  };

  private eventQueue: Array<{
    event: RecordedEvent;
    scheduledTime: number;
    executed: boolean;
  }> = [];
  private nextEventIndex = 0;

  private cursor: HTMLElement | null = null;
  private replayStartTime: number = 0;
  private session: SessionData | null = null;
  private startIndex: number = 0;
  private pendingMockCount: number = 0;

  public onStop?: () => void;

  // Async event handling
  private microtaskQueue: Function[] = [];
  private macrotaskQueue: Function[] = [];
  private isProcessingQueues = false;

  // Error tracking
  private replayErrors: Array<{
    event: RecordedEvent;
    code: string;
    message: string;
    details?: string;
    stage?: string;
    timestamp: number;
  }> = [];

  private boundUnloadHandler = () => this.stop(false);

  async start(session: SessionData & { initialState?: any }, options: { speed?: number; isResume?: boolean; resumeIndex?: number } = {}) {
    if (this.isReplaying) return;
    this.isReplaying = true;
    this.session = session;
    this.state.speed = options.speed || 1;
    this.replayStartTime = performance.now();
    this.replayErrors = [];

    // Set global flag to prevent recorder from capturing replayed events
    (window as any)._replayx_is_replaying = true;

    const isResuming = options.isResume || sessionStorage.getItem('replayx_active') === 'true';
    const currentUrl = this.normalizeUrl(window.location.href);
    const sessionStartUrl = this.normalizeUrl(session.url);
    const isSessionStartPage = currentUrl === sessionStartUrl;

    if (!isResuming) {
      sessionStorage.setItem('replayx_event_index', '0');
    }

    // Restore initial state only when we are replaying from the first recorded page.
    if (session.initialState && !isResuming && isSessionStartPage) {
      console.log('[ReplayX Replayer] Initial state found. Clearing and restoring storage...');
      
      // Clear current state to ensure determinism
      localStorage.clear();
      sessionStorage.clear();

      // Restore localStorage safely
      if (session.initialState.localStorage) {
        Object.entries(session.initialState.localStorage).forEach(([k, v]) => localStorage.setItem(k, v as string));
      }

      // Restore sessionStorage safely
      if (session.initialState.sessionStorage) {
        Object.entries(session.initialState.sessionStorage).forEach(([k, v]) => sessionStorage.setItem(k, v as string));
      }
      
      // Set control flag AFTER restoration so it isn't wiped
      sessionStorage.setItem('replayx_active', 'true');
      
      // A reload is required for the app to initialize with the injected storage
      console.log('[ReplayX Replayer] Initial state restored. Reloading to initialize app...');
      window.location.reload();
      return;
    }

    if (!sessionStorage.getItem('replayx_active')) {
      sessionStorage.setItem('replayx_active', 'true');
    }

    console.log('[ReplayX Replayer] Starting deterministic replay for session:', session.id);

    // Configure network interceptor
    window.postMessage({
      source: 'replayx-content',
      action: 'SET_MODE',
      mode: 'REPLAY',
      networkEvents: session.events.filter(e => e.type === 'Network').map(e => ({
        id: e.id,
        ...e.payload
      }))
    }, '*');

    // Track how many network mocks are available to be consumed
    this.pendingMockCount = session.events.filter(e => e.type === 'Network').length;

    // Listen for interceptor messages about mocks being consumed
    window.addEventListener('message', this.boundInterceptorMessage);

    this.createCursor();
    this.scheduleEvents(session.events, options.resumeIndex);
    window.addEventListener('beforeunload', this.boundUnloadHandler);

    // Start replay loop
    this.state.isPlaying = true;
    this.replayLoop();

    // Set up replay controls
    this.setupKeyboardControls();
  }

  private boundInterceptorMessage = (ev: MessageEvent) => {
    try {
      if (!ev.data || ev.data.source !== 'replayx-interceptor') return;
      if (ev.data.action === 'MOCK_CONSUMED') {
        // A mock was consumed; decrement pending count if present
        this.pendingMockCount = Math.max(0, this.pendingMockCount - 1);
      }
    } catch (e) {}
  }

  public isActive(): boolean {
    return this.isReplaying;
  }

  stop(isFinished = false) {
    if (!this.isReplaying) return;
    this.isReplaying = false;
    this.state.isPlaying = false;
    this.eventQueue = [];
    (window as any)._replayx_is_replaying = false;
    window.removeEventListener('beforeunload', this.boundUnloadHandler);
    this.microtaskQueue = [];
    this.macrotaskQueue = [];

    if (this.cursor) {
      this.cursor.remove();
      this.cursor = null;
    }

    // Reset interceptor
    window.postMessage({
      source: 'replayx-content',
      action: 'SET_MODE',
      mode: 'IDLE'
    }, '*');

    window.removeEventListener('message', this.boundInterceptorMessage);

    // Signal completion to the background script so it can clear the active session state.
    // This must be sent whenever replaying stops to ensure the background script 
    // doesn't stay in a "replaying" state.
    if (isFinished) {
      // Clear client-side state immediately so UI reflects completion quickly
      try {
        sessionStorage.removeItem('replayx_active');
        sessionStorage.removeItem('replayx_event_index');
      } catch (e) {
        console.warn('[ReplayX Replayer] Failed to clear sessionStorage on finish', e);
      }

      // Notify background and log the result. Use callback to surface errors.
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: 'REPLAY_FINISHED', errors: this.replayErrors }, (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('[ReplayX Replayer] REPLAY_FINISHED message failed:', chrome.runtime.lastError.message);
          } else {
            console.log('[ReplayX Replayer] Background acknowledged REPLAY_FINISHED', resp);
          }
        });
      } else {
        console.log('[ReplayX Replayer] No chrome.runtime available to send REPLAY_FINISHED');
      }
    } else {
      // Don't remove replayx_active if we are just navigating
    }

    if (this.onStop) this.onStop();
    console.log('[ReplayX Replayer] Replay stopped');
  }

  public async step() {
    if (!this.isReplaying) return;
    // execute a single event regardless of timing
    if (this.nextEventIndex >= this.eventQueue.length) return;

    const item = this.eventQueue[this.nextEventIndex];
    try {
      const navigationTriggered = await this.executeEvent(item.event);
      item.executed = true;
      this.nextEventIndex += 1;

      const progressIndex = this.startIndex + this.nextEventIndex;
      sessionStorage.setItem('replayx_event_index', progressIndex.toString());
      this.persistReplayProgress(progressIndex);

      // Process async queues after the single step
      await this.processAsyncQueues();

      // Pause after stepping
      this.pause();

      if (navigationTriggered) {
        this.stop(false);
        return;
      }
    } catch (error) {
      console.error('[ReplayX Replayer] Step execution failed:', item.event, error);
      this.recordReplayError(item.event, 'step_failed', 'Replay step failed', error instanceof Error ? error.message : String(error), 'step');
      this.nextEventIndex += 1;
    }
  }

  pause() {
    this.state.paused = true;
    console.log('[ReplayX Replayer] Replay paused');
  }

  resume() {
    this.state.paused = false;
    console.log('[ReplayX Replayer] Replay resumed');
  }

  setSpeed(speed: number) {
    this.state.speed = Math.max(0.1, Math.min(10, speed));
    console.log('[ReplayX Replayer] Speed set to:', this.state.speed);
    // Dynamically adjust cursor transition to match replay speed
    if (this.cursor) {
      this.cursor.style.transition = `all ${0.2 / this.state.speed}s ease-out`;
    }
  }

  private scheduleEvents(events: RecordedEvent[], resumeIndex?: number) {
    // Use index-based tracking to handle multiple visits to the same URL correctly
    const savedIndex = sessionStorage.getItem('replayx_event_index');
    if (savedIndex !== null) {
      this.startIndex = parseInt(savedIndex, 10);
    } else if (resumeIndex !== undefined) {
      this.startIndex = resumeIndex;
      console.log('[ReplayX Replayer] Resuming from persisted background index', this.startIndex, 'for', window.location.href);
    } else {
      this.startIndex = this.findResumeIndex(events);
      console.log('[ReplayX Replayer] Resuming from event index', this.startIndex, 'for', window.location.href);
    }

    const eventsToSchedule = events.slice(this.startIndex);
    const offset = eventsToSchedule.length > 0 ? eventsToSchedule[0].timestamp : 0;

    this.eventQueue = eventsToSchedule.map(event => ({
      event,
      // scheduledTime is now relative to the current page load
      scheduledTime: event.timestamp - offset,
      executed: false
    })).sort((a, b) => a.scheduledTime - b.scheduledTime);

    this.nextEventIndex = 0;
    console.log(`[ReplayX Replayer] Scheduled ${this.eventQueue.length} events (offset ${offset}ms)`);
  }

  private findResumeIndex(events: RecordedEvent[]): number {
    const currentUrl = this.normalizeUrl(window.location.href);
    for (let i = 0; i < events.length; i++) {
      const frameUrl = this.normalizeUrl(events[i].payload.frameUrl || '');
      if (frameUrl && frameUrl === currentUrl) {
        return i;
      }
    }
    return 0;
  }

  private normalizeUrl(url: string): string {
    return url.split('#')[0].replace(/\/$/, '').toLowerCase();
  }

  private persistReplayProgress(progressIndex: number) {
    if (!this.session || !chrome.runtime?.id) return;
    chrome.runtime.sendMessage({
      action: 'UPDATE_REPLAY_PROGRESS',
      sessionId: this.session.id,
      progressIndex
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[ReplayX Replayer] Could not persist replay progress:', chrome.runtime.lastError.message);
      }
    });
  }

  private async replayLoop() {
    while (this.isReplaying && this.state.isPlaying) {
      if (this.state.paused) {
        await this.delayMs(100);
        continue;
      }

      const currentTime = (performance.now() - this.replayStartTime) * this.state.speed;
      this.state.currentTime = currentTime;

      // Execute due events in queue order
      while (this.nextEventIndex < this.eventQueue.length &&
             !this.eventQueue[this.nextEventIndex].executed &&
             this.eventQueue[this.nextEventIndex].scheduledTime <= currentTime) {
        const item = this.eventQueue[this.nextEventIndex];
        
        // Frame Safety: Only execute events that belong to THIS frame
        if (item.event.payload.frameUrl) {
          const normalize = (u: string) => u.split('#')[0].replace(/\/$/, '').toLowerCase();
          if (normalize(item.event.payload.frameUrl) !== normalize(window.location.href)) {
            item.executed = true;
            this.nextEventIndex += 1;
            continue;
          }
        }

        try {
          const navigationTriggered = await this.executeEvent(item.event);
          item.executed = true;
          this.nextEventIndex += 1;
          
          // Persist progress across reloads and navigation.
          const progressIndex = this.startIndex + this.nextEventIndex;
          sessionStorage.setItem('replayx_event_index', progressIndex.toString());
          this.persistReplayProgress(progressIndex);

          if (navigationTriggered) {
            this.stop(false); // Stop local loop but keep background session active
            return;
          }
        } catch (error) {
          console.error('[ReplayX Replayer] Event execution failed:', item.event, error);
          this.recordReplayError(item.event, 'event_failed', 'Replay event failed', error instanceof Error ? error.message : String(error), 'playback');
          this.nextEventIndex += 1;
        }
      }

      // Process async queues
      await this.processAsyncQueues();

      // Check if replay is complete
      if (this.nextEventIndex >= this.eventQueue.length) {
        console.log('[ReplayX Replayer] All events replayed');
        this.stop(true);
        return;
      }

      // Small delay to prevent busy loop
      await this.delayMs(16); // ~60fps
    }
  }

  private async executeEvent(event: RecordedEvent): Promise<boolean | void> {
    switch (event.type) {
      case 'Click':
        return await this.executeClick(event);
      case 'DoubleClick':
        return await this.executeClick(event);
      case 'Key':
        return await this.executeKey(event);
      case 'Input':
        return await this.executeInput(event);
      case 'Change':
        return await this.executeChange(event);
      case 'Submit':
        return await this.executeSubmit(event);
      case 'Scroll':
        return await this.executeScroll(event);
      case 'Mutation':
        return await this.executeMutation(event);
      case 'Navigation':
        return await this.executeNavigation(event);
      case 'Resize':
        return await this.executeResize(event);
      case 'Focus':
        return await this.executeFocus(event);
      case 'Blur':
        return await this.executeBlur(event);
      default:
        console.warn('[ReplayX Replayer] Unknown event type:', event.type);
    }
  }

  private async executeClick(event: RecordedEvent) {
    if (event.type !== 'Click') return;
    const payload = event.payload as ClickPayload;
    let element = await this.findElement({ selector: payload.selector, fallbackSelectors: payload.fallbackSelectors, textSnippet: payload.textSnippet, name: payload.name, dataTestId: payload.dataTestId });

    if (!element) {
      const dom = document.body ? document.body.innerHTML.slice(0, 5000) : '';
      console.warn('[ReplayX Replayer] Click target not found:', payload.selector);
      this.recordReplayError(event, 'target_not_found', 'Click target was not found', 'The recorded selector could not be resolved during replay.', 'find', dom);
      return;
    }

    // Ensure element is visible - 'auto' has broader support for standard DOM
    element.scrollIntoView({ behavior: 'auto', block: 'center' });
    await this.delayMs(50);

    // Move cursor
    this.moveCursorTo(element);
    await this.delayMs(100);

    // Use exact recorded coordinates for maximum fidelity
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      clientX: payload.x,
      clientY: payload.y
    };

    element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
    await this.delayMs(20);
    element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
    
    // Use native click() as it triggers both the event and the default browser action
    element.click();
    if ((payload as any).dbl) {
      element.dispatchEvent(new MouseEvent('dblclick', eventOptions));
    }

    // Wait for network or DOM settle heuristics
    await this.waitForReplaySettling(1500);
  }

  private async executeInput(event: RecordedEvent) {
    if (event.type !== 'Input') return;
    const payload = event.payload as InputPayload;
    const value = payload.value;
    let element = await this.findElement({ selector: payload.selector, fallbackSelectors: payload.fallbackSelectors, textSnippet: payload.textSnippet, name: payload.name, dataTestId: payload.dataTestId });

    if (!element) {
      const dom = document.body ? document.body.innerHTML.slice(0, 5000) : '';
      console.warn('[ReplayX Replayer] Input target not found:', payload.selector);
      this.recordReplayError(event, 'target_not_found', 'Input target was not found', 'The recorded selector could not be resolved during replay.', 'find', dom);
      return;
    }

    element.scrollIntoView({ behavior: 'auto', block: 'center' });
    await this.delayMs(50);

    this.moveCursorTo(element);
    await this.delayMs(100);

    // Focus first
    element.focus();
    await this.delayMs(50);

    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
      const isChecked = value === 'true';
      if (element.checked !== isChecked) {
        this.setNativeProps(element, 'checked', isChecked);
      }
    } 
    // Handle contenteditable
    else if (element.hasAttribute('contenteditable')) {
      if (element.innerText !== value) {
        element.innerText = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    // Standard inputs
    else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (element.value !== value) {
        element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: value }));
        this.setNativeProps(element, 'value', value);
      }
    }
  }

  private async executeChange(event: RecordedEvent) {
    if (event.type !== 'Change') return;
    const payload = event.payload as ChangePayload;
    let element = await this.findElement({ selector: payload.selector, fallbackSelectors: payload.fallbackSelectors, textSnippet: payload.textSnippet, name: payload.name, dataTestId: payload.dataTestId });
    if (!element) {
      const dom = document.body ? document.body.innerHTML.slice(0, 5000) : '';
      console.warn('[ReplayX Replayer] Change target not found:', payload.selector);
      this.recordReplayError(event, 'target_not_found', 'Change target was not found', 'The recorded selector could not be resolved during replay.', 'find', dom);
      return;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      this.setNativeProps(element, 'value', payload.value);
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  private async executeSubmit(event: RecordedEvent) {
    if (event.type !== 'Submit') return;
    const payload = event.payload as SubmitPayload;
    let element = await this.findElement({ selector: payload.selector, fallbackSelectors: payload.fallbackSelectors, textSnippet: payload.textSnippet, name: payload.name, dataTestId: payload.dataTestId });
    if (!element) {
      const dom = document.body ? document.body.innerHTML.slice(0, 5000) : '';
      console.warn('[ReplayX Replayer] Submit target not found:', payload.selector);
      this.recordReplayError(event, 'target_not_found', 'Submit target was not found', 'The recorded selector could not be resolved during replay.', 'find', dom);
      return;
    }

    const form = element instanceof HTMLFormElement ? element : element.closest('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      try {
        form.requestSubmit?.();
      } catch (e) {
        /* ignore if not supported */
      }
    }
  }

  private async executeKey(event: RecordedEvent) {
    if (event.type !== 'Key') return;
    const payload = event.payload as any;
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;

    const evDown = new KeyboardEvent('keydown', {
      key: payload.key,
      code: payload.code,
      altKey: !!payload.altKey,
      ctrlKey: !!payload.ctrlKey,
      metaKey: !!payload.metaKey,
      shiftKey: !!payload.shiftKey,
      bubbles: true
    });
    active.dispatchEvent(evDown);

    const evUp = new KeyboardEvent('keyup', {
      key: payload.key,
      code: payload.code,
      altKey: !!payload.altKey,
      ctrlKey: !!payload.ctrlKey,
      metaKey: !!payload.metaKey,
      shiftKey: !!payload.shiftKey,
      bubbles: true
    });
    active.dispatchEvent(evUp);
  }

  private async executeScroll(event: RecordedEvent) {
    if (event.type !== 'Scroll') return;
    const payload = event.payload as ScrollPayload;
    const selector = payload.selector;
    const scrollTop = payload.scrollTop;
    const scrollLeft = payload.scrollLeft;

    let element = selector === 'window' ? window : await this.findElement({ selector: payload.selector, fallbackSelectors: payload.fallbackSelectors, textSnippet: payload.textSnippet, name: payload.name, dataTestId: payload.dataTestId });
    if (!element) return;

    if (element === window) {
      window.scrollTo(scrollLeft, scrollTop);
    } else {
      (element as HTMLElement).scrollTop = scrollTop;
      (element as HTMLElement).scrollLeft = scrollLeft;
      // Manually trigger scroll event as direct property mutation doesn't always fire it
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }

  private async executeMutation(event: RecordedEvent) {
    if (event.type !== 'Mutation') return;
    const payload = event.payload as MutationPayload;
    // For replay, mutations are handled by the original events that caused them
    // This is mainly for logging/debugging
    console.log('[ReplayX Replayer] Mutation event:', payload.type, payload.targetSelector);
  }

  private async executeNavigation(event: RecordedEvent) {
    if (event.type !== 'Navigation') return;
    const payload = event.payload as NavigationPayload & { navigationType?: string };
    const url = payload.url;
    const navigationType = payload.navigationType || 'navigate';

    if (navigationType === 'back') {
      window.history.back();
      await this.waitForReplaySettling(1000);
      return true;
    }

    if (navigationType === 'forward') {
      window.history.forward();
      await this.waitForReplaySettling(1000);
      return true;
    }

    const normalize = (u: string) => u.replace(/\/$/, '').toLowerCase();
    if (normalize(window.location.href) !== normalize(url)) {
      console.log('[ReplayX Replayer] Redirecting to next page:', url);
      window.location.assign(url);
      return true;
    }
    return false;
  }

  private waitForNetworkIdle(timeoutMs: number = 2000): Promise<void> {
    const start = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        if (this.pendingMockCount <= 0) return resolve();
        if (performance.now() - start > timeoutMs) return resolve();
        setTimeout(check, 50);
      };
      check();
    });
  }

  private async waitForReplaySettling(timeoutMs: number = 2000): Promise<void> {
    await this.waitForNetworkIdle(timeoutMs);
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      await this.delayMs(50);
      if (document.readyState === 'complete') break;
    }
  }

  private recordReplayError(
    event: RecordedEvent,
    code: string,
    message: string,
    details?: string,
    stage: string = 'playback',
    domSnippet?: string
  ) {
    const errorEntry = {
      event,
      code,
      message,
      details,
      stage,
      timestamp: Date.now()
    } as const;

    this.replayErrors.push(errorEntry as any);
    if (domSnippet) {
      (this.replayErrors[this.replayErrors.length - 1] as any).dom = domSnippet;
    }
  }

  private async executeResize(event: RecordedEvent) {
    // Resize events are informational, actual resize is handled by browser
    console.log('[ReplayX Replayer] Resize event:', event.payload);
  }

  private async executeFocus(event: RecordedEvent) {
    if (event.type !== 'Focus') return;
    const payload = event.payload as FocusPayload;
    let element = await this.findElement({ selector: payload.selector, fallbackSelectors: payload.fallbackSelectors, textSnippet: payload.textSnippet, name: payload.name, dataTestId: payload.dataTestId }) as HTMLElement;
    if (element) {
      element.focus();
    }
  }

  private async executeBlur(event: RecordedEvent) {
    if (event.type !== 'Blur') return;
    const payload = event.payload as BlurPayload;
    let element = await this.findElement({ selector: payload.selector, fallbackSelectors: payload.fallbackSelectors, textSnippet: payload.textSnippet, name: payload.name, dataTestId: payload.dataTestId }) as HTMLElement;
    if (element) {
      element.blur();
    }
  }

  private async findElement(selectorOrObj: any, timeoutMs: number = 3000): Promise<HTMLElement | null> {
    const selector = typeof selectorOrObj === 'string' ? selectorOrObj : selectorOrObj?.selector;
    const fallbackSelectors: string[] = typeof selectorOrObj === 'object' ? selectorOrObj?.fallbackSelectors || [] : [];
    const textSnippet = typeof selectorOrObj === 'object' ? selectorOrObj?.textSnippet : undefined;
    const name = typeof selectorOrObj === 'object' ? selectorOrObj?.name : undefined;
    const dataTestId = typeof selectorOrObj === 'object' ? selectorOrObj?.dataTestId : undefined;
    const startTime = performance.now();

    const candidates = [selector, ...fallbackSelectors];
    if (name) candidates.push(`${selectorOrObj.targetTag || '*'}[name="${name}"]`, `[name="${name}"]`);
    if (dataTestId) candidates.push(`[data-testid="${dataTestId}"]`, `[data-cy="${dataTestId}"]`, `[data-test="${dataTestId}"]`, `[data-qa="${dataTestId}"]`);

    while (performance.now() - startTime < timeoutMs) {
      try {
        for (const candidate of candidates) {
          if (!candidate) continue;
          let element = this.querySelectorDeep(candidate);
          if (!element) {
            element = this.tryAlternativeSelectors(candidate, textSnippet);
          }
          if (element && (this.isElementInteractable(element) || element.matches('input, textarea, select, form'))) {
            return element;
          }
        }
      } catch (e) {}

      await this.delayMs(100);
    }

    return null;
  }

  /**
   * Shadow-piercing query selector
   */
  private querySelectorDeep(selector: string, root: Document | Element | ShadowRoot = document): HTMLElement | null {
    if (root instanceof Element && root.matches(selector)) return root as HTMLElement;

    const el = (root as Document | Element | ShadowRoot).querySelector(selector) as HTMLElement;
    if (el) return el;

    const elements = (root as Document).querySelectorAll('*');
    for (let i = 0; i < elements.length; i++) {
      const shadowRoot = elements[i].shadowRoot;
      if (shadowRoot) {
        const found = this.querySelectorDeep(selector, shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Programmatically set property bypassing framework (React/Vue) setter overrides
   */
  private setNativeProps(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, prop: 'value' | 'checked', value: any) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, prop);
    
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      (element as any)[prop] = value;
    }

    // Trigger events to notify framework observers
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  private tryAlternativeSelectors(originalSelector: string, textSnippet?: string): HTMLElement | null {
    // Try data attributes
    const dataAttrs = ['data-testid', 'data-cy', 'data-test'];
    for (const attr of dataAttrs) {
      if (originalSelector.includes(`[${attr}`)) {
        const value = originalSelector.match(new RegExp(`\\[${attr}="([^"]+)"\\]`))?.[1];
        if (value) {
          // Fix 3: Use querySelectorDeep for alternative selectors to support Shadow DOM
          const element = this.querySelectorDeep(`[${attr}="${value}"]`);
          if (element) return element;
        }
      }
    }

    // Try ID
    const idMatch = originalSelector.match(/#([^ >]+)/);
    if (idMatch) {
      const element = this.querySelectorDeep(`#${idMatch[1]}`);
      if (element) return element;
    }

    // Try simplified selector
    const parts = originalSelector.split(' > ');
    const lastPart = parts[parts.length - 1].split(':')[0];
    let element = this.querySelectorDeep(lastPart);
    if (element) return element;

    // If we have a text snippet, try matching by tag + text content contains snippet
    if (textSnippet) {
      try {
        const tagMatch = lastPart.match(/^([a-z0-9\-]+)/i);
        const tag = tagMatch ? tagMatch[1] : null;
        const candidates = tag ? Array.from(document.querySelectorAll(tag)) : Array.from(document.querySelectorAll('*'));
        for (const c of candidates) {
          const el = c as HTMLElement;
          if (el && (el.textContent || '').includes(textSnippet)) return el;
        }
      } catch (e) {}
    }

    return null;
  }

  private isElementInteractable(element: HTMLElement): boolean {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0' &&
           !element.hasAttribute('disabled') &&
           rect.width > 0 &&
           rect.height > 0;
  }

  private async processAsyncQueues() {
    if (this.isProcessingQueues) return;
    this.isProcessingQueues = true;

    // Process microtasks first
    while (this.microtaskQueue.length > 0) {
      const task = this.microtaskQueue.shift()!;
      try {
        await task();
      } catch (error) {
        console.error('[ReplayX Replayer] Microtask error:', error);
      }
    }

    // Process macrotasks
    while (this.macrotaskQueue.length > 0) {
      const task = this.macrotaskQueue.shift()!;
      try {
        await task();
      } catch (error) {
        console.error('[ReplayX Replayer] Macrotask error:', error);
      }
    }

    this.isProcessingQueues = false;
  }

  private createCursor() {
    if (this.cursor) return;

    this.cursor = document.createElement('div');
    Object.assign(this.cursor.style, {
      position: 'fixed',
      width: '20px',
      height: '20px',
      borderRadius: '50%',
      backgroundColor: 'rgba(255, 0, 0, 0.8)',
      border: '2px solid #ff0000',
      zIndex: '9999999',
      pointerEvents: 'none',
      transition: `all ${0.2 / this.state.speed}s ease-out`,
      boxShadow: '0 0 10px rgba(255, 0, 0, 0.5)'
    });

    document.body.appendChild(this.cursor);
  }

  private moveCursorTo(element: HTMLElement) {
    if (!this.cursor) return;

    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - 10;
    const y = rect.top + rect.height / 2 - 10;

    this.cursor.style.left = `${x}px`;
    this.cursor.style.top = `${y}px`;
    this.cursor.style.transform = 'scale(1.2)';

    setTimeout(() => {
      if (this.cursor) this.cursor.style.transform = 'scale(1)';
    }, 200);
  }

  private setupKeyboardControls() {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (this.state.paused) this.resume();
          else this.pause();
          break;
        case 'Escape':
          e.preventDefault();
          this.stop();
          break;
      }
    };

    document.addEventListener('keydown', handler);

    // Cleanup on stop
    const originalStop = this.stop.bind(this);
    this.stop = (isFinished?: boolean) => {
      document.removeEventListener('keydown', handler);
      originalStop(isFinished);
    };
  }

  private delayMs(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms / this.state.speed));
  }
}
