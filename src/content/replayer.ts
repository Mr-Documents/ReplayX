import { SessionData, RecordedEvent, ReplayState, ClickPayload, InputPayload, ScrollPayload, MutationPayload, NavigationPayload, FocusPayload, BlurPayload } from '../types';

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

  // Async event handling
  private microtaskQueue: Function[] = [];
  private macrotaskQueue: Function[] = [];
  private isProcessingQueues = false;

  // Error tracking
  private replayErrors: Array<{ event: RecordedEvent; error: string }> = [];

  async start(session: SessionData & { initialState?: any }, options: { speed?: number } = {}) {
    if (this.isReplaying) return;
    this.isReplaying = true;
    this.session = session;
    this.state.speed = options.speed || 1;
    this.replayStartTime = performance.now();
    this.replayErrors = [];

    // Check if we are starting from scratch or resuming after a navigation
    const isResuming = sessionStorage.getItem('replayx_active') === 'true';

    // MVP Improvement: Restore Initial State only on the first page of the session
    if (session.initialState && !isResuming) {
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

    console.log('[ReplayX Replayer] Starting deterministic replay for session:', session.id);

    // Configure network interceptor
    window.postMessage({
      source: 'replayx-content',
      action: 'SET_MODE',
      mode: 'REPLAY',
      networkEvents: session.events.filter(e => e.type === 'Network')
    }, '*');

    this.createCursor();
    this.scheduleEvents(session.events, window.location.href);

    // Start replay loop
    this.state.isPlaying = true;
    this.replayLoop();

    // Set up replay controls
    this.setupKeyboardControls();
  }

  stop(isFinished = false) {
    this.isReplaying = false;
    this.state.isPlaying = false;
    this.eventQueue = [];
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

    // Only signal completion to the background if we actually finished or were manually stopped
    if ((isFinished || !window.closed) && chrome.runtime?.id) {
      chrome.runtime.sendMessage({
        action: 'REPLAY_FINISHED',
        errors: this.replayErrors
      });
    }

    console.log('[ReplayX Replayer] Replay stopped');
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
  }

  private scheduleEvents(events: RecordedEvent[], currentUrl: string) {
    // Filter events to only include those relevant to the current page.
    // We skip all events that happened before the last 'Navigation' to this URL.
    let lastNavIndex = -1;
    for (let i = 0; i < events.length; i++) {
      const payload = events[i].payload as NavigationPayload;
      if (events[i].type === 'Navigation' && payload.url === currentUrl) {
        lastNavIndex = i;
      }
    }

    const eventsToSchedule = lastNavIndex !== -1 ? events.slice(lastNavIndex) : events;
    const offset = eventsToSchedule.length > 0 ? eventsToSchedule[0].timestamp : 0;

    this.eventQueue = eventsToSchedule.map(event => ({
      event,
      scheduledTime: event.timestamp - offset,
      executed: false
    })).sort((a, b) => a.scheduledTime - b.scheduledTime);

    this.nextEventIndex = 0;
    console.log(`[ReplayX Replayer] Scheduled ${this.eventQueue.length} events (offset ${offset}ms)`);
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
        try {
          await this.executeEvent(item.event);
          item.executed = true;
        } catch (error) {
          console.error('[ReplayX Replayer] Event execution failed:', item.event, error);
          this.replayErrors.push({
            event: item.event,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        this.nextEventIndex += 1;
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

  private async executeEvent(event: RecordedEvent) {
    switch (event.type) {
      case 'Click':
        await this.executeClick(event);
        break;
      case 'Input':
        await this.executeInput(event);
        break;
      case 'Scroll':
        await this.executeScroll(event);
        break;
      case 'Mutation':
        await this.executeMutation(event);
        break;
      case 'Navigation':
        await this.executeNavigation(event);
        break;
      case 'Resize':
        await this.executeResize(event);
        break;
      case 'Focus':
        await this.executeFocus(event);
        break;
      case 'Blur':
        await this.executeBlur(event);
        break;
      default:
        console.warn('[ReplayX Replayer] Unknown event type:', event.type);
    }
  }

  private async executeClick(event: RecordedEvent) {
    if (event.type !== 'Click') return;
    const payload = event.payload as ClickPayload;
    const selector = payload.selector;
    let element = this.findElement(selector);

    if (!element) {
      console.warn('[ReplayX Replayer] Click target not found:', selector);
      return;
    }

    // Ensure element is visible
    element.scrollIntoView({ behavior: 'instant', block: 'center' });
    await this.delayMs(50);

    // Move cursor
    this.moveCursorTo(element);
    await this.delayMs(100);

    // Check if element is interactable
    if (!this.isElementInteractable(element)) {
      console.warn('[ReplayX Replayer] Element not interactable:', selector);
      return;
    }

    // Dispatch mouse events in correct order
    const rect = element.getBoundingClientRect();
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };

    element.dispatchEvent(new MouseEvent('mouseenter', eventOptions));
    await this.delayMs(10);
    element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
    await this.delayMs(10);
    element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
    await this.delayMs(10);
    element.dispatchEvent(new MouseEvent('click', eventOptions));
  }

  private async executeInput(event: RecordedEvent) {
    if (event.type !== 'Input') return;
    const payload = event.payload as InputPayload;
    const selector = payload.selector;
    const value = payload.value;
    let element = this.findElement(selector) as HTMLInputElement | HTMLTextAreaElement;

    if (!element) {
      console.warn('[ReplayX Replayer] Input target not found:', selector);
      return;
    }

    element.scrollIntoView({ behavior: 'instant', block: 'center' });
    await this.delayMs(50);

    this.moveCursorTo(element);
    await this.delayMs(100);

    if (!this.isElementInteractable(element)) {
      console.warn('[ReplayX Replayer] Input element not interactable:', selector);
      return;
    }

    // Focus first
    element.focus();
    await this.delayMs(50);

    // Set value and dispatch events
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await this.delayMs(50);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  private async executeScroll(event: RecordedEvent) {
    if (event.type !== 'Scroll') return;
    const payload = event.payload as ScrollPayload;
    const selector = payload.selector;
    const scrollTop = payload.scrollTop;
    const scrollLeft = payload.scrollLeft;

    let element = selector === 'window' ? window : this.findElement(selector);
    if (!element) return;

    if (element === window) {
      window.scrollTo(scrollLeft, scrollTop);
    } else {
      (element as HTMLElement).scrollTop = scrollTop;
      (element as HTMLElement).scrollLeft = scrollLeft;
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
    const payload = event.payload as NavigationPayload;
    const url = payload.url;
    console.log('[ReplayX Replayer] Navigation to:', url);
    // Navigation is handled at the session level, not per event
  }

  private async executeResize(event: RecordedEvent) {
    // Resize events are informational, actual resize is handled by browser
    console.log('[ReplayX Replayer] Resize event:', event.payload);
  }

  private async executeFocus(event: RecordedEvent) {
    if (event.type !== 'Focus') return;
    const payload = event.payload as FocusPayload;
    const selector = payload.selector;
    let element = this.findElement(selector) as HTMLElement;
    if (element) {
      element.focus();
    }
  }

  private async executeBlur(event: RecordedEvent) {
    if (event.type !== 'Blur') return;
    const payload = event.payload as BlurPayload;
    const selector = payload.selector;
    let element = this.findElement(selector) as HTMLElement;
    if (element) {
      element.blur();
    }
  }

  private findElement(selector: string): HTMLElement | null {
    try {
      // Try primary selector
      let element = document.querySelector(selector) as HTMLElement;
      if (element) return element;

      // Try alternative selectors
      return this.tryAlternativeSelectors(selector);
    } catch (error) {
      console.error('[ReplayX Replayer] Error finding element:', selector, error);
      return null;
    }
  }

  private tryAlternativeSelectors(originalSelector: string): HTMLElement | null {
    // Try data attributes
    const dataAttrs = ['data-testid', 'data-cy', 'data-test'];
    for (const attr of dataAttrs) {
      if (originalSelector.includes(`[${attr}`)) {
        const value = originalSelector.match(new RegExp(`\\[${attr}="([^"]+)"\\]`))?.[1];
        if (value) {
          const element = document.querySelector(`[${attr}="${value}"]`) as HTMLElement;
          if (element) return element;
        }
      }
    }

    // Try ID
    const idMatch = originalSelector.match(/#([^ >]+)/);
    if (idMatch) {
      const element = document.getElementById(idMatch[1]);
      if (element) return element;
    }

    // Try simplified selector
    const parts = originalSelector.split(' > ');
    const lastPart = parts[parts.length - 1].split(':')[0];
    const element = document.querySelector(lastPart) as HTMLElement;
    if (element) return element;

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
      transition: 'all 0.2s ease-out',
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
    this.stop = () => {
      document.removeEventListener('keydown', handler);
      originalStop();
    };
  }

  private delayMs(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms / this.state.speed));
  }
}
