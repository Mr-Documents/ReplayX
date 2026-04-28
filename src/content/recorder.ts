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
    let path = [];
    while (el.nodeType === Node.ELEMENT_NODE) {
      let selector = el.nodeName.toLowerCase();
      if (el.id) {
        selector += '#' + el.id;
        path.unshift(selector);
        break; // IDs are unique, can stop traversing
      } else {
        let sibling = el, nth = 1;
        while (sibling = sibling.previousElementSibling as HTMLElement) {
          if (sibling.nodeName.toLowerCase() == selector) nth++;
        }
        if (nth != 1) selector += `:nth-of-type(${nth})`;
      }
      path.unshift(selector);
      el = el.parentNode as HTMLElement;
      if (!el || el.tagName.toLowerCase() === 'html') break;
    }
    return path.join(' > ');
  }
}
