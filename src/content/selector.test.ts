import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildTargetPayload,
  cssEscape,
  getFallbackSelectors,
  getRobustSelector,
  getStructuralPath,
  isReplayXNode,
  REPLAYX_UI_ATTR,
} from './selector';

beforeEach(() => {
  document.body.innerHTML = '';
});

function q(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`fixture missing: ${selector}`);
  return el;
}

describe('getRobustSelector', () => {
  it('prefers a test id over everything else', () => {
    document.body.innerHTML = '<button id="save" class="btn primary" data-testid="save-btn">Save</button>';
    expect(getRobustSelector(q('button'))).toBe('[data-testid="save-btn"]');
  });

  it('falls back to an id when there is no test id', () => {
    document.body.innerHTML = '<button id="save" class="btn">Save</button>';
    expect(getRobustSelector(q('button'))).toBe('#save');
  });

  it('never returns a selector that matches more than one element', () => {
    // The old implementation happily emitted `button.btn` here, so replay
    // resolved the first button no matter which one was recorded.
    document.body.innerHTML = `
      <div><button class="btn">One</button></div>
      <div><button class="btn">Two</button></div>`;
    const second = document.querySelectorAll('button')[1]!;
    const selector = getRobustSelector(second);

    const matches = document.querySelectorAll(selector);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(second);
  });

  it('rejects a duplicated id and produces a unique structural path instead', () => {
    document.body.innerHTML = '<p id="dup">a</p><p id="dup">b</p>';
    const second = document.querySelectorAll('p')[1]!;
    const selector = getRobustSelector(second);
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(second);
  });

  it('escapes ids containing CSS metacharacters', () => {
    // `#user.name` is a class selector on element `user`; unescaped it silently
    // resolved the wrong node (or threw for ids starting with a digit).
    document.body.innerHTML = '<div id="user.name:1">x</div>';
    const el = q('div');
    const selector = getRobustSelector(el);
    expect(() => document.querySelector(selector)).not.toThrow();
    expect(document.querySelector(selector)).toBe(el);
  });

  it('ignores volatile and generated class names', () => {
    document.body.innerHTML = '<a class="active css-1x2y3z4 checkout-link">go</a>';
    expect(getRobustSelector(q('a'))).toBe('a.checkout-link');
  });

  it('uses a name attribute when classes are not distinguishing', () => {
    document.body.innerHTML = '<form><input name="email" class="input"><input name="pw" class="input"></form>';
    expect(getRobustSelector(q('input[name="email"]'))).toBe('input[name="email"]');
  });
});

describe('getStructuralPath', () => {
  it('is anchored at the document root', () => {
    document.body.innerHTML = '<section><span>hi</span></section>';
    const path = getStructuralPath(q('span'));
    // Without the anchor the path could match an identically shaped subtree
    // anywhere in the document.
    expect(path.startsWith('html > body')).toBe(true);
    expect(document.querySelector(path)).toBe(q('span'));
  });

  it('disambiguates siblings of the same tag', () => {
    document.body.innerHTML = '<ul><li>a</li><li>b</li><li>c</li></ul>';
    const third = document.querySelectorAll('li')[2]!;
    const path = getStructuralPath(third);
    expect(path).toContain('li:nth-of-type(3)');
    expect(document.querySelector(path)).toBe(third);
  });
});

describe('getFallbackSelectors', () => {
  it('always ends with a guaranteed-unique structural path', () => {
    document.body.innerHTML = '<button id="go" name="go" aria-label="Go">Go</button>';
    const fallbacks = getFallbackSelectors(q('button'), '#go');
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(document.querySelector(fallbacks[fallbacks.length - 1]!)).toBe(q('button'));
  });

  it('does not repeat the primary selector', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    expect(getFallbackSelectors(q('button'), '#go')).not.toContain('#go');
  });
});

describe('buildTargetPayload', () => {
  it('captures identity hints for replay', () => {
    document.body.innerHTML = '<input id="email" name="email" data-testid="email-field" value="x">';
    const payload = buildTargetPayload(q('input'));
    expect(payload.selector).toBe('[data-testid="email-field"]');
    expect(payload.id).toBe('email');
    expect(payload.name).toBe('email');
    expect(payload.dataTestId).toBe('email-field');
    expect(payload.targetTag).toBe('input');
  });

  it('truncates the text snippet', () => {
    document.body.innerHTML = `<p>${'x'.repeat(500)}</p>`;
    expect(buildTargetPayload(q('p')).textSnippet).toHaveLength(120);
  });
});

describe('isReplayXNode', () => {
  it('detects ReplayX-owned elements and their descendants', () => {
    document.body.innerHTML = `<div ${REPLAYX_UI_ATTR}="widget"><span id="dot"></span></div><p id="page"></p>`;
    expect(isReplayXNode(q(`[${REPLAYX_UI_ATTR}]`))).toBe(true);
    expect(isReplayXNode(q('#dot'))).toBe(true);
    expect(isReplayXNode(q('#page'))).toBe(false);
    expect(isReplayXNode(null)).toBe(false);
  });
});

describe('cssEscape', () => {
  it('escapes characters that would change selector meaning', () => {
    expect(cssEscape('a.b')).not.toBe('a.b');
    expect(document.querySelectorAll(`#${cssEscape('a.b')}`)).toHaveLength(0);
  });
});
