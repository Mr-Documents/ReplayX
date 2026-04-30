import { ClickEvent, InputEvent, RecordedEvent } from '../types';

export class Recorder {
  private events: RecordedEvent[] = [];
  private sessionStartTime: number = 0;
  private isRecording = false;

  private boundClickHandler = this.onClick.bind(this);
  private boundInputHandler = this.onInput.bind(this);

  start() {
    if (this.isRecording) return;
    this.isRecording = true;
    this.events = [];
    this.sessionStartTime = Date.now();

    document.addEventListener('click', this.boundClickHandler, true);
    document.addEventListener('input', this.boundInputHandler, true);
  }

  stop(): { events: RecordedEvent[], startTime: number } {
    this.isRecording = false;
    document.removeEventListener('click', this.boundClickHandler, true);
    document.removeEventListener('input', this.boundInputHandler, true);

    const result = {
      events: this.events,
      startTime: this.sessionStartTime
    };
    this.events = [];
    return result;
  }

  addEvent(event: RecordedEvent) {
    if (this.isRecording) {
      this.events.push(event);
    }
  }

  private onClick(e: MouseEvent) {
    if (!this.isRecording) return;
    const target = e.target as HTMLElement;
    const selector = this.getSelector(target);

    this.events.push({
      type: 'Click',
      timestamp: performance.now(),
      selector
    });
  }

  private onInput(e: Event) {
    if (!this.isRecording) return;
    const target = e.target as HTMLInputElement;
    const selector = this.getSelector(target);

    this.events.push({
      type: 'Input',
      timestamp: performance.now(),
      selector,
      value: target.value
    });
  }

  private getSelector(el: HTMLElement): string {
    if (el.tagName.toLowerCase() === 'html') return 'html';
    
    // Try ID first - most reliable
    if (el.id) {
      return `#${el.id}`;
    }
    
    // Try data attributes if present
    if (el.getAttribute('data-testid')) {
      return `[data-testid="${el.getAttribute('data-testid')}"]`;
    }
    
    if (el.getAttribute('data-cy')) {
      return `[data-cy="${el.getAttribute('data-cy')}"]`;
    }
    
    // Generate path-based selector as fallback
    let path = [];
    let currentEl = el;
    
    while (currentEl && currentEl.nodeType === Node.ELEMENT_NODE) {
      let selector = currentEl.nodeName.toLowerCase();
      
      // Add classes if they seem stable (not utility classes)
      if (currentEl.className) {
        const classes = currentEl.className.split(' ').filter(cls => 
          cls && !cls.includes('hover') && !cls.includes('active') && 
          cls.length > 2 && !cls.match(/^\d+$/)
        );
        if (classes.length > 0 && classes.length <= 3) {
          selector += '.' + classes.join('.');
        }
      }
      
      // Add nth-of-type for disambiguation
      if (!currentEl.id) {
        let sibling = currentEl, nth = 1;
        while (sibling = sibling.previousElementSibling as HTMLElement) {
          if (sibling.nodeName.toLowerCase() === selector.split('.')[0]) nth++;
        }
        if (nth > 1) selector += `:nth-of-type(${nth})`;
      }
      
      path.unshift(selector);
      currentEl = currentEl.parentNode as HTMLElement;
      
      // Stop at body to keep selectors reasonable
      if (!currentEl || currentEl.tagName.toLowerCase() === 'body') break;
    }
    
    const fullSelector = path.join(' > ');
    
    // If selector is too long, try a shorter version
    if (fullSelector.length > 100) {
      // Try just the element with classes and nth-of-type
      const simpleSelector = el.nodeName.toLowerCase();
      const classes = el.className.split(' ').filter(cls => 
        cls && !cls.includes('hover') && !cls.includes('active') && 
        cls.length > 2 && !cls.match(/^\d+$/)
      );
      if (classes.length > 0) {
        return simpleSelector + '.' + classes.join('.');
      }
      return simpleSelector;
    }
    
    return fullSelector;
  }
}
