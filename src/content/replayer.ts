import { SessionData, RecordedEvent } from '../types';

export class Replayer {
  private isReplaying = false;

  async start(session: SessionData) {
    if (this.isReplaying) return;
    this.isReplaying = true;

    console.log('[ReplayX] Starting replay for session', session.id);
    
    // Configure interceptor for network mocking
    window.postMessage({
      source: 'replayx-content',
      action: 'SET_MODE',
      mode: 'REPLAY',
      events: session.events
    }, '*');

    // Simulate events sequentially based on timestamp
    const domEvents = session.events.filter(e => e.type === 'Click' || e.type === 'Input');
    
    if (domEvents.length === 0) {
      console.log('[ReplayX] No DOM events to replay');
      this.isReplaying = false;
      return;
    }

    const firstEventTime = domEvents[0].timestamp;
    
    for (let i = 0; i < domEvents.length; i++) {
        const ev = domEvents[i];
        const prevEv = i > 0 ? domEvents[i-1] : domEvents[0];
        
        let delay = ev.timestamp - prevEv.timestamp;
        
        // Capping max delay for usability between steps (e.g. max 2 seconds)
        if (delay > 2000) delay = 2000;
        
        await this.delayMs(delay);
        
        try {
            this.dispatchDOMEvent(ev);
        } catch (e) {
            console.error('[ReplayX] Failed to dispatch event', ev, e);
        }
    }

    console.log('[ReplayX] Replay Finished.');
    this.isReplaying = false;
  }

  private dispatchDOMEvent(ev: RecordedEvent) {
      if (ev.type === 'Click') {
          const el = document.querySelector(ev.selector);
          if (el) {
              // Simulate real click visualization or properties (simple logic for MVP)
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          } else {
              console.warn('[ReplayX Replayer] Click target not found:', ev.selector);
          }
      } else if (ev.type === 'Input') {
          const el = document.querySelector(ev.selector) as HTMLInputElement;
          if (el) {
              el.value = ev.value;
              el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          } else {
              console.warn('[ReplayX Replayer] Input target not found:', ev.selector);
          }
      }
  }

  private delayMs(ms: number) {
      return new Promise(resolve => setTimeout(resolve, ms));
  }
}
