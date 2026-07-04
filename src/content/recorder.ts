import {
  RecordedEvent,
  ClickEvent,
  InputEvent,
  ChangeEvent,
  FormSubmitEvent,
  ScrollEvent,
  MutationEvent,
  NavigationEvent,
  ResizeEvent,
  FocusEvent,
  BlurEvent,
  TargetPayload,
  ClickPayload,
  InputPayload,
  ChangePayload,
  SubmitPayload
} from '../types';
import { SessionData } from '../types';

export class Recorder {
  private events: RecordedEvent[] = [];
  private sessionId: string = '';
  private sequenceCounter: number = 0;
  private sessionStartTime: number = 0;
  private isRecording = false;
  private isPaused = false;
  private historyLength = 0;
  private initialState: any = null;
  private mutationObserver: MutationObserver | null = null;
  private scrollTimeout: number | null = null;

  // Event handlers
  private boundClickHandler = this.onClick.bind(this);
  private boundDblClickHandler = this.onDblClick.bind(this);
  private boundInputHandler = this.onInput.bind(this);
  private boundChangeHandler = this.onChange.bind(this);
  private boundSubmitHandler = this.onSubmit.bind(this);
  private boundScrollHandler = this.onScroll.bind(this);
  private boundResizeHandler = this.onResize.bind(this);
  private boundFocusHandler = this.onFocus.bind(this);
  private boundBlurHandler = this.onBlur.bind(this);
  private boundKeyDownHandler = this.onKeyDown.bind(this);
  private boundKeyUpHandler = this.onKeyUp.bind(this);
  private boundNavigationHandler = this.onNavigation.bind(this);

  start(sessionId: string, sessionStartTime?: number) {
    if (this.isRecording) return;
    this.isRecording = true;
    this.isPaused = false;
    this.sessionId = sessionId;
    this.events = [];
    this.sessionStartTime = sessionStartTime ?? Date.now();
    this.historyLength = window.history.length;

    // MVP Improvement: Capture initial state correctly using helper
    this.initialState = {
      localStorage: this.captureStorage(localStorage),
      sessionStorage: this.captureStorage(sessionStorage),
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      cookies: document.cookie
    };
    console.log('[ReplayX Recorder] Captured initial state');

    // Add event listeners
    document.addEventListener('click', this.boundClickHandler, true);
    document.addEventListener('dblclick', this.boundDblClickHandler, true);
    document.addEventListener('input', this.boundInputHandler, true);
    document.addEventListener('change', this.boundChangeHandler, true);
    document.addEventListener('submit', this.boundSubmitHandler, true);
    document.addEventListener('scroll', this.boundScrollHandler, true);
    window.addEventListener('resize', this.boundResizeHandler);
    document.addEventListener('focus', this.boundFocusHandler, true);
    document.addEventListener('blur', this.boundBlurHandler, true);
    document.addEventListener('keydown', this.boundKeyDownHandler, true);
    document.addEventListener('keyup', this.boundKeyUpHandler, true);

    // Navigation events
    this.setupNavigationTracking();

    // If resuming after a reload, record the current location immediately
    if (sessionStartTime) {
      this.onNavigation();
    }

    // Mutation observer for DOM changes
    this.setupMutationObserver();

    console.log('[ReplayX Recorder] Started recording session:', sessionId);
  }

  stop(): { events: RecordedEvent[], startTime: number, initialState: any } {
    if (!this.isRecording) return { events: [], startTime: 0, initialState: null };

    this.isRecording = false;

    // Remove event listeners
    document.removeEventListener('click', this.boundClickHandler, true);
    document.removeEventListener('dblclick', this.boundDblClickHandler, true);
    document.removeEventListener('input', this.boundInputHandler, true);
    document.removeEventListener('change', this.boundChangeHandler, true);
    document.removeEventListener('submit', this.boundSubmitHandler, true);
    document.removeEventListener('scroll', this.boundScrollHandler, true);
    window.removeEventListener('resize', this.boundResizeHandler);
    document.removeEventListener('focus', this.boundFocusHandler, true);
    document.removeEventListener('blur', this.boundBlurHandler, true);
    document.removeEventListener('keydown', this.boundKeyDownHandler, true);
    document.removeEventListener('keyup', this.boundKeyUpHandler, true);
    this.cleanupNavigationTracking();

    // Disconnect mutation observer
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }

    // Clear scroll timeout
    if (this.scrollTimeout) {
      clearTimeout(this.scrollTimeout);
      this.scrollTimeout = null;
    }

    const result = {
      events: this.events,
      startTime: this.sessionStartTime,
      initialState: this.initialState
    };
    this.events = [];
    this.initialState = null;
    console.log('[ReplayX Recorder] Stopped recording, captured', result.events.length, 'events');
    return result;
  }

  pause() {
    this.isPaused = true;
    console.log('[ReplayX Recorder] Recording paused');
  }

  resume() {
    this.isPaused = false;
    console.log('[ReplayX Recorder] Recording resumed');
  }

  public addEvent(event: RecordedEvent) {
    // Guard 1: Prevent recording events triggered by the replayer
    if ((window as any)._replayx_is_replaying) return;

    if (this.isRecording && !this.isPaused) {
      // assign monotonic sequence number
      this.sequenceCounter += 1;
      (event as any).sequence = this.sequenceCounter;
      // Guard 2: Tag the event with the current frame's URL for deterministic replay
      event.payload.frameUrl = window.location.href;
      this.events.push(event);
    }
  }

  public flushEvents(): RecordedEvent[] {
    const flushed = this.events;
    this.events = [];
    return flushed;
  }

  public isRecordingActive(): boolean {
    return this.isRecording;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getSessionStartTime(): number {
    return this.sessionStartTime;
  }

  private getTimestamp(): number {
    return Date.now() - this.sessionStartTime;
  }

  private captureStorage(storage: Storage): Record<string, string> {
    const data: Record<string, string> = {};
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key) {
        data[key] = storage.getItem(key) || '';
      }
    }
    return data;
  }

  private onClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const selectorPayload = this.buildTargetPayload(target);

    this.addEvent({
      id: this.generateId(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Click',
      payload: {
        ...selectorPayload,
        x: e.clientX,
        y: e.clientY
      }
    });
  }

  private onDblClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const selectorPayload = this.buildTargetPayload(target);

    this.addEvent({
      id: this.generateId(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Click',
      payload: {
        ...selectorPayload,
        x: e.clientX,
        y: e.clientY,
        dbl: true
      }
    });
  }

  private onInput(e: Event) {
    const target = e.target as HTMLElement;
    const inputTarget = target as HTMLInputElement;
    const selectorPayload = this.buildTargetPayload(target);

    // Handle specialized input types
    let value: string;
    if (inputTarget?.type === 'checkbox' || inputTarget?.type === 'radio') {
      value = String(inputTarget.checked);
    } else if (target.hasAttribute('contenteditable')) {
      value = target.innerText;
    } else {
      value = inputTarget?.value || '';
    }

    // Basic privacy masking
    let maskedValue = value;
    const isSensitive = ((target as HTMLInputElement).type === 'password' || 
                        target.getAttribute('name')?.toLowerCase().includes('card') ||
                        target.hasAttribute('data-replay-mask')) &&
                        !['checkbox', 'radio'].includes((target as HTMLInputElement).type);
    if (isSensitive) maskedValue = '********';

    this.addEvent({
      id: this.generateId(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Input',
      payload: {
        ...selectorPayload,
        value: maskedValue,
        inputType: (e as any).inputType || inputTarget?.type || 'unknown'
      }
    });
  }

  private onChange(e: Event) {
    const target = e.target as HTMLElement;
    const inputTarget = target as HTMLInputElement;
    const selectorPayload = this.buildTargetPayload(target);

    let value = '';
    if (inputTarget?.type === 'checkbox' || inputTarget?.type === 'radio') {
      value = String(inputTarget.checked);
    } else if (target.hasAttribute('contenteditable')) {
      value = target.innerText;
    } else {
      value = inputTarget?.value || '';
    }

    this.addEvent({
      id: this.generateId(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Change',
      payload: {
        ...selectorPayload,
        value,
        inputType: (e.target as HTMLInputElement)?.type || 'unknown'
      }
    });
  }

  private onSubmit(e: Event) {
    const form = (e.target as HTMLElement).closest('form') as HTMLFormElement | null;
    if (!form) return;
    const selectorPayload = this.buildTargetPayload(form);

    this.addEvent({
      id: this.generateId(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Submit',
      payload: {
        ...selectorPayload,
        formAction: form.action || undefined,
        formMethod: form.method || undefined
      }
    });
  }

  private onKeyDown(e: KeyboardEvent) {
    // Don't record modifier repeats as separate if needed, but include all for fidelity
    this.addEvent({
      id: this.generateId(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Key',
      payload: {
        key: e.key,
        code: e.code,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey
      }
    });
  }

  private onKeyUp(e: KeyboardEvent) {
    this.addEvent({
      id: this.generateId(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Key',
      payload: {
        key: e.key,
        code: e.code,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey
      }
    });
  }

  private onScroll(e: Event) {
    // Normalize target for window-level scrolling
    const target = e.target === document ? (document.scrollingElement || document.documentElement) : (e.target as HTMLElement);
    
    const selector = this.getRobustSelector(target);

    // Debounce scroll events
    if (this.scrollTimeout) clearTimeout(this.scrollTimeout);
    this.scrollTimeout = window.setTimeout(() => {
      this.addEvent({
        id: this.generateId(),
        sessionId: this.sessionId,
        timestamp: this.getTimestamp(),
        type: 'Scroll',
        payload: {
          selector,
          scrollTop: target.scrollTop || window.scrollY,
          scrollLeft: target.scrollLeft || window.scrollX
        }
      });
    }, 100);
  }

  private onResize() {
    this.addEvent({
      id: this.generateId(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Resize',
      payload: {
        width: window.innerWidth,
        height: window.innerHeight
      }
    });
  }

  private onFocus(e: Event) {
    const target = e.target as HTMLElement;
    const selectorPayload = this.buildTargetPayload(target);

    this.addEvent({
      id: this.generateId(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Focus',
      payload: selectorPayload
    });
  }

  private onBlur(e: Event) {
    const target = e.target as HTMLElement;
    const selectorPayload = this.buildTargetPayload(target);

    this.addEvent({
      id: this.generateId(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Blur',
      payload: selectorPayload
    });
  }

  private onNavigation(e?: Event) {
    const navigationType = this.getNavigationType(e);
    this.addEvent({
      id: this.generateId(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Navigation',
      payload: {
        url: window.location.href,
        referrer: document.referrer,
        navigationType
      }
    });
  }

  private getNavigationType(e?: Event): 'navigate' | 'push' | 'replace' | 'back' | 'forward' {
    if (e?.type === 'popstate') {
      const currentLength = window.history.length;
      const previousLength = this.historyLength;
      this.historyLength = currentLength;
      if (currentLength < previousLength) return 'back';
      if (currentLength > previousLength) return 'forward';
      return 'navigate';
    }

    if (e?.type === 'pushstate') return 'push';
    if (e?.type === 'replacestate') return 'replace';
    return 'navigate';
  }

  private generateId(): string {
    // Fallback for non-HTTPS sites where crypto.randomUUID is unavailable
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }

  private setupNavigationTracking() {
    window.addEventListener('popstate', this.boundNavigationHandler);
    window.addEventListener('hashchange', this.boundNavigationHandler);

    // Monkey-patch History API to detect SPA transitions
    // Guard against multiple patches if the script is re-injected
    if ((history.pushState as any)._isReplayXPatched) return;

    const recorder = this;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(...args: any[]) {
      originalPushState.apply(this, args);
      recorder.onNavigation({ type: 'pushstate' } as Event);
    };

    history.replaceState = function(...args: any[]) {
      originalReplaceState.apply(this, args);
      recorder.onNavigation({ type: 'replacestate' } as Event);
    };

    (history.pushState as any)._isReplayXPatched = true;
    (this as any)._originalPushState = originalPushState;
    (this as any)._originalReplaceState = originalReplaceState;
  }

  private cleanupNavigationTracking() {
    window.removeEventListener('popstate', this.boundNavigationHandler);
    window.removeEventListener('hashchange', this.boundNavigationHandler);
    if ((this as any)._originalPushState) {
      history.pushState = (this as any)._originalPushState;
      history.replaceState = (this as any)._originalReplaceState;
    }
  }

  private setupMutationObserver() {
    this.mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        const target = mutation.target as HTMLElement;
        const selector = this.getRobustSelector(target);

        let mutationEvent: Omit<MutationEvent, 'id' | 'sessionId' | 'timestamp'>;

        if (mutation.type === 'childList') {
          mutationEvent = {
            type: 'Mutation',
            payload: {
              type: 'childList',
              targetSelector: selector,
              addedNodes: Array.from(mutation.addedNodes).map(node =>
                node.nodeType === Node.ELEMENT_NODE ? (node as Element).outerHTML : node.textContent || ''
              ),
              removedNodes: Array.from(mutation.removedNodes).map(node =>
                node.nodeType === Node.ELEMENT_NODE ? (node as Element).outerHTML : node.textContent || ''
              )
            }
          };
        } else if (mutation.type === 'attributes') {
          mutationEvent = {
            type: 'Mutation',
            payload: {
              type: 'attributes',
              targetSelector: selector,
              attributeName: mutation.attributeName || '',
              attributeValue: target.getAttribute(mutation.attributeName || '') || '',
              oldValue: mutation.oldValue || ''
            }
          };
        } else if (mutation.type === 'characterData') {
          mutationEvent = {
            type: 'Mutation',
            payload: {
              type: 'characterData',
              targetSelector: selector,
              oldValue: mutation.oldValue || '',
              newValue: target.textContent || ''
            }
          };
        } else {
          return; // Skip unknown mutation types
        }

        this.addEvent({
          id: this.generateId(),
          sessionId: this.sessionId,
          timestamp: this.getTimestamp(),
          ...mutationEvent
        });
      });
    });

    this.mutationObserver.observe(document.body, {
      childList: true,
      attributes: true,
      characterData: true,
      subtree: true,
      attributeOldValue: true,
      characterDataOldValue: true
    });
  }

  private buildTargetPayload(el: Element): TargetPayload {
    const selector = this.getRobustSelector(el);
    const id = (el as HTMLElement).id || undefined;
    const name = (el as HTMLElement).getAttribute('name') || undefined;
    const dataTestId = ['data-testid', 'data-cy', 'data-test', 'data-qa']
      .map(attr => ({ attr, value: el.getAttribute(attr) }))
      .find(item => item.value)?.value;

    return {
      selector,
      fallbackSelectors: this.getFallbackSelectors(el, selector),
      id,
      name,
      dataTestId,
      targetTag: el.tagName.toLowerCase(),
      textSnippet: (el.textContent || '').trim().slice(0, 120),
      frameUrl: window.location.href
    };
  }

  private getFallbackSelectors(el: Element, primary: string): string[] {
    const selectors: string[] = [];

    if ((el as HTMLElement).id) {
      selectors.push(`#${(el as HTMLElement).id}`);
    }

    const nameAttr = (el as HTMLElement).getAttribute('name');
    if (nameAttr) {
      selectors.push(`${el.tagName.toLowerCase()}[name="${nameAttr}"]`);
    }

    const dataAttrs = ['data-testid', 'data-cy', 'data-test', 'data-qa'];
    dataAttrs.forEach(attr => {
      const value = el.getAttribute(attr);
      if (value) {
        selectors.push(`[${attr}="${value}"]`);
      }
    });

    const classes = Array.from(el.classList)
      .filter(cls => cls.length > 2 && !cls.match(/^(hover|active|focus|visited|link|disabled|enabled|checked|selected|valid|invalid|required|optional)$/i));
    if (classes.length > 0) {
      selectors.push(`${el.tagName.toLowerCase()}.${classes.slice(0, 3).join('.')}`);
    }

    if (primary && !selectors.includes(primary)) {
      selectors.unshift(primary);
    }

    return selectors.filter(Boolean);
  }

  private getRobustSelector(el: Element): string {
    // Priority: data attributes > ID > stable classes > XPath fallback

    const dataAttrs = ['data-testid', 'data-cy', 'data-test', 'data-qa'];
    for (const attr of dataAttrs) {
      const value = el.getAttribute(attr);
      if (value) return `[${attr}="${value}"]`;
    }

    if ((el as HTMLElement).id) {
      return `#${(el as HTMLElement).id}`;
    }

    const classes = Array.from(el.classList).filter(cls =>
      cls.length > 2 &&
      !cls.match(/^(hover|active|focus|visited|link|disabled|enabled|checked|selected|valid|invalid|required|optional)$/i) &&
      !cls.match(/^(col|row|container|wrapper|item|element|component)$/i) &&
      !cls.match(/^\d+$/)
    );

    if (classes.length > 0 && classes.length <= 3) {
      return `${el.tagName.toLowerCase()}.${classes.join('.')}`;
    }

    const path: string[] = [];
    let current: Element | null = el;

    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      const siblings = Array.from(current.parentElement?.children || []);
      const index = siblings.indexOf(current) + 1;
      if (siblings.length > 1) {
        selector += `:nth-child(${index})`;
      }
      path.unshift(selector);
      current = current.parentElement;
    }

    return path.join(' > ');
  }
}
