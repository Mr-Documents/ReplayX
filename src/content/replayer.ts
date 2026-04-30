import { SessionData, RecordedEvent } from '../types';

export class Replayer {
  private isReplaying = false;
  private cursor: HTMLElement | null = null;

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

    this.createCursor();

    // Simulate events sequentially based on timestamp
    const domEvents = session.events.filter(e => e.type === 'Click' || e.type === 'Input');
    
    if (domEvents.length === 0) {
      console.log('[ReplayX] No DOM events to replay');
      this.finishReplay();
      return;
    }

    const firstEventTime = domEvents[0].timestamp;
    
    for (let i = 0; i < domEvents.length; i++) {
        const ev = domEvents[i];
        const prevEv = i > 0 ? domEvents[i-1] : domEvents[0];
        
        let delay = ev.timestamp - prevEv.timestamp;
        if (delay > 2000) delay = 2000;
        
        await this.delayMs(delay);
        
        try {
            await this.dispatchDOMEvent(ev);
        } catch (e) {
            console.error('[ReplayX] Failed to dispatch event', ev, e);
        }
    }

    console.log('[ReplayX] Replay Finished.');
    this.finishReplay();
  }

  private finishReplay() {
    this.isReplaying = false;
    if (this.cursor) {
      this.cursor.remove();
      this.cursor = null;
    }
    chrome.runtime.sendMessage({ action: 'REPLAY_FINISHED' });
  }

  private createCursor() {
    if (this.cursor) return;
    this.cursor = document.createElement('div');
    this.cursor.style.width = '20px';
    this.cursor.style.height = '20px';
    this.cursor.style.borderRadius = '10px';
    this.cursor.style.backgroundColor = 'rgba(255, 0, 0, 0.5)';
    this.cursor.style.border = '2px solid red';
    this.cursor.style.position = 'fixed';
    this.cursor.style.zIndex = '9999999';
    this.cursor.style.pointerEvents = 'none';
    this.cursor.style.transition = 'all 0.3s ease-out';
    this.cursor.style.top = '50%';
    this.cursor.style.left = '50%';
    document.body.appendChild(this.cursor);
  }

  private moveCursorTo(el: HTMLElement) {
    if (!this.cursor) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    this.cursor.style.left = `${x - 10}px`;
    this.cursor.style.top = `${y - 10}px`;
    
    // add click ripple effect
    this.cursor.style.transform = 'scale(0.8)';
    setTimeout(() => {
        if (this.cursor) this.cursor.style.transform = 'scale(1)';
    }, 150);
  }

  private async dispatchDOMEvent(ev: RecordedEvent) {
      if (ev.type === 'Click') {
          const el = document.querySelector(ev.selector) as HTMLElement;
          if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await this.delayMs(300); // Wait for scroll
              this.moveCursorTo(el);
              await this.delayMs(300); // Wait for cursor move
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          } else {
              console.warn('[ReplayX Replayer] Click target not found:', ev.selector);
          }
      } else if (ev.type === 'Input') {
          const el = document.querySelector(ev.selector) as HTMLInputElement;
          if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await this.delayMs(300);
              this.moveCursorTo(el);
              await this.delayMs(300);
              el.value = ev.value || '';
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
