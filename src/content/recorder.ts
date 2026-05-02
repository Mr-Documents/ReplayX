import {
  RecordedEvent,
  ClickEvent,
  InputEvent,
  ScrollEvent,
  MutationEvent,
  NavigationEvent,
  ResizeEvent,
  FocusEvent,
  BlurEvent
} from '../types';

export class Recorder {
  private events: RecordedEvent[] = [];
  private sessionId: string = '';
  private sessionStartTime: number = 0;
  private isRecording = false;
  private mutationObserver: MutationObserver | null = null;
  private scrollTimeout: number | null = null;

  // Event handlers
  private boundClickHandler = this.onClick.bind(this);
  private boundInputHandler = this.onInput.bind(this);
  private boundScrollHandler = this.onScroll.bind(this);
  private boundResizeHandler = this.onResize.bind(this);
  private boundFocusHandler = this.onFocus.bind(this);
  private boundBlurHandler = this.onBlur.bind(this);
  private boundNavigationHandler = this.onNavigation.bind(this);

  start(sessionId: string, sessionStartTime?: number) {
    if (this.isRecording) return;
    this.isRecording = true;
    this.sessionId = sessionId;
    this.events = [];
    this.sessionStartTime = sessionStartTime ?? Date.now();

    // Add event listeners
    document.addEventListener('click', this.boundClickHandler, true);
    document.addEventListener('input', this.boundInputHandler, true);
    document.addEventListener('scroll', this.boundScrollHandler, true);
    window.addEventListener('resize', this.boundResizeHandler);
    document.addEventListener('focus', this.boundFocusHandler, true);
    document.addEventListener('blur', this.boundBlurHandler, true);

    // Navigation events
    window.addEventListener('popstate', this.boundNavigationHandler);
    window.addEventListener('pushstate', this.boundNavigationHandler); // Custom event if needed

    // Mutation observer for DOM changes
    this.setupMutationObserver();

    console.log('[ReplayX Recorder] Started recording session:', sessionId);
  }

  stop(): { events: RecordedEvent[], startTime: number } {
    if (!this.isRecording) return { events: [], startTime: 0 };

    this.isRecording = false;

    // Remove event listeners
    document.removeEventListener('click', this.boundClickHandler, true);
    document.removeEventListener('input', this.boundInputHandler, true);
    document.removeEventListener('scroll', this.boundScrollHandler, true);
    window.removeEventListener('resize', this.boundResizeHandler);
    document.removeEventListener('focus', this.boundFocusHandler, true);
    document.removeEventListener('blur', this.boundBlurHandler, true);
    window.removeEventListener('popstate', this.boundNavigationHandler);

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
      startTime: this.sessionStartTime
    };
    this.events = [];
    console.log('[ReplayX Recorder] Stopped recording, captured', result.events.length, 'events');
    return result;
  }

  public addEvent(event: RecordedEvent) {
    if (this.isRecording) {
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

  private onClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const selector = this.getRobustSelector(target);
    const rect = target.getBoundingClientRect();

    this.addEvent({
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Click',
      payload: {
        selector,
        x: e.clientX,
        y: e.clientY,
        targetTag: target.tagName.toLowerCase()
      }
    });
  }

  private onInput(e: Event) {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    const selector = this.getRobustSelector(target);

    this.addEvent({
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Input',
      payload: {
        selector,
        value: target.value,
        inputType: (e as any).inputType || 'unknown'
      }
    });
  }

  private onScroll(e: Event) {
    const target = e.target as HTMLElement;
    const selector = this.getRobustSelector(target);

    // Debounce scroll events
    if (this.scrollTimeout) clearTimeout(this.scrollTimeout);
    this.scrollTimeout = window.setTimeout(() => {
      this.addEvent({
        id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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
    const selector = this.getRobustSelector(target);

    this.addEvent({
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Focus',
      payload: { selector }
    });
  }

  private onBlur(e: Event) {
    const target = e.target as HTMLElement;
    const selector = this.getRobustSelector(target);

    this.addEvent({
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Blur',
      payload: { selector }
    });
  }

  private onNavigation(e: Event) {
    this.addEvent({
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      timestamp: this.getTimestamp(),
      type: 'Navigation',
      payload: {
        url: window.location.href,
        referrer: document.referrer
      }
    });
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
          id: crypto.randomUUID(),
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

  private getRobustSelector(el: Element): string {
    // Priority: data attributes > ID > stable classes > XPath fallback

    // Data attributes (preferred)
    const dataAttrs = ['data-testid', 'data-cy', 'data-test', 'data-qa'];
    for (const attr of dataAttrs) {
      const value = el.getAttribute(attr);
      if (value) return `[${attr}="${value}"]`;
    }

    // ID
    if ((el as HTMLElement).id) {
      return `#${(el as HTMLElement).id}`;
    }

    // Stable classes (exclude utility classes)
    const classes = Array.from(el.classList).filter(cls =>
      cls.length > 2 &&
      !cls.match(/^(hover|active|focus|visited|link|disabled|enabled|checked|selected|valid|invalid|required|optional)$/i) &&
      !cls.match(/^(col|row|container|wrapper|item|element|component)$/i) &&
      !cls.match(/^\d+$/)
    );

    if (classes.length > 0 && classes.length <= 3) {
      return `${el.tagName.toLowerCase()}.${classes.join('.')}`;
    }

    // XPath-style selector as fallback
    let path = [];
    let current: Element | null = el;

    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();

      // Add nth-child for uniqueness
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
