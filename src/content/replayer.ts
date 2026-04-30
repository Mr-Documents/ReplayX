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
    const networkEvents = session.events.filter(e => e.type === 'Network');
    
    console.log(`[ReplayX] Found ${domEvents.length} DOM events and ${networkEvents.length} network events`);
    
    if (domEvents.length === 0 && networkEvents.length === 0) {
      console.log('[ReplayX] No events to replay');
      alert('ReplayX: No events were recorded in this session.');
      this.finishReplay();
      return;
    }
    
    if (domEvents.length === 0) {
      console.log('[ReplayX] Only network events found - network mocking is active');
      // Show a brief message then finish - network events are handled by interceptor
      setTimeout(() => {
        console.log('[ReplayX] Network replay complete');
        this.finishReplay();
      }, 2000);
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
          let el = document.querySelector(ev.selector) as HTMLElement;
          
          // Try alternative selectors if primary fails
          if (!el) {
            el = this.tryAlternativeSelectors(ev.selector);
          }
          
          if (el) {
              console.log('[ReplayX] Clicking element:', ev.selector);
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await this.delayMs(300); // Wait for scroll
              this.moveCursorTo(el);
              await this.delayMs(300); // Wait for cursor move
              
              // Ensure element is visible and enabled
              if (this.isElementInteractable(el)) {
                  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                  await this.delayMs(50);
                  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                  await this.delayMs(50);
                  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              } else {
                  console.warn('[ReplayX] Element not interactable:', ev.selector);
              }
          } else {
              console.warn('[ReplayX Replayer] Click target not found:', ev.selector);
          }
      } else if (ev.type === 'Input') {
          let el = document.querySelector(ev.selector) as HTMLInputElement;
          
          // Try alternative selectors if primary fails
          if (!el) {
            el = this.tryAlternativeSelectors(ev.selector) as HTMLInputElement;
          }
          
          if (el) {
              console.log('[ReplayX] Inputting into element:', ev.selector);
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await this.delayMs(300);
              this.moveCursorTo(el);
              await this.delayMs(300);
              
              if (this.isElementInteractable(el)) {
                  el.value = ev.value || '';
                  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                  await this.delayMs(100);
                  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              } else {
                  console.warn('[ReplayX] Input element not interactable:', ev.selector);
              }
          } else {
              console.warn('[ReplayX Replayer] Input target not found:', ev.selector);
          }
      }
  }

  private tryAlternativeSelectors(originalSelector: string): HTMLElement | null {
    // Try to find element by text content if it's a button/link
    if (originalSelector.includes('button') || originalSelector.includes('a')) {
      const elements = Array.from(document.querySelectorAll('button, a'));
      for (const el of elements) {
        if (el.textContent && el.textContent.trim().length > 0) {
          return el as HTMLElement;
        }
      }
    }
    
    // Try simplified selector (just tag name and classes)
    const parts = originalSelector.split(' > ');
    const lastPart = parts[parts.length - 1];
    const simpleSelector = lastPart.split(':')[0]; // Remove nth-of-type
    
    const el = document.querySelector(simpleSelector);
    if (el) return el as HTMLElement;
    
    // Try to find by ID if selector contains one
    const idMatch = originalSelector.match(/#([^ >]+)/);
    if (idMatch) {
      const idEl = document.getElementById(idMatch[1]);
      if (idEl) return idEl;
    }
    
    return null;
  }

  private isElementInteractable(el: HTMLElement): boolean {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && 
           style.visibility !== 'hidden' && 
           !el.hasAttribute('disabled') &&
           el.offsetWidth > 0 && 
           el.offsetHeight > 0;
  }

  private delayMs(ms: number) {
      return new Promise(resolve => setTimeout(resolve, ms));
  }
}
