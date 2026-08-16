import type { TargetPayload } from '../types';

/**
 * Selector generation for recording and resolution for replay.
 *
 * The guiding rule is that a recorded selector must be *unique* at record time.
 * The previous implementation happily emitted `button.btn` for a page with
 * fifty such buttons, so replay would resolve the wrong element and then report
 * a spurious "no DOM change" mismatch.
 */

/** Marks nodes ReplayX injects itself, so they are never recorded or targeted. */
export const REPLAYX_UI_ATTR = 'data-replayx-ui';

const TEST_ID_ATTRS = ['data-testid', 'data-cy', 'data-test', 'data-qa'] as const;

/** Class names that describe transient state rather than identity. */
const VOLATILE_CLASS = /^(hover|active|focus|focused|visited|link|disabled|enabled|checked|selected|valid|invalid|required|optional|open|closed|show|hidden|is-.*|has-.*)$/i;
/** Generic layout classes that are never distinguishing on their own. */
const GENERIC_CLASS = /^(col|row|container|wrapper|item|element|component|content|inner|outer|box|flex|grid)$/i;
/** Hashed / generated class names (CSS modules, styled-components, Tailwind JIT). */
const GENERATED_CLASS = /^(css-[a-z0-9]+|sc-[a-z0-9]+|jsx-\d+|[a-z0-9_-]*__[a-z0-9]{5,}|[a-z0-9]{8,})$/i;

export function cssEscape(value: string): string {
  const globalCss = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (typeof globalCss?.escape === 'function') return globalCss.escape(value);
  // Minimal fallback for environments without CSS.escape (older jsdom).
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

/**
 * Reads `tagName` without trusting it. Proxied, cross-realm, and custom
 * elements can throw on property access, and the sibling walk in
 * `getStructuralPath` touches every child of every ancestor - so one hostile
 * node would otherwise make its entire subtree unrecordable.
 */
function safeTagName(el: Element): string {
  try {
    const tag = el.tagName;
    return typeof tag === 'string' ? tag : '';
  } catch {
    return '';
  }
}

export function isReplayXNode(node: Node | null): boolean {
  if (!node) return false;
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node.parentElement as Element | null);
  return Boolean(element?.closest?.(`[${REPLAYX_UI_ATTR}]`));
}

function isUnique(selector: string, el: Element, root: ParentNode): boolean {
  try {
    const matches = root.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === el;
  } catch {
    return false;
  }
}

function usefulClasses(el: Element): string[] {
  return Array.from(el.classList).filter(
    (cls) =>
      cls.length > 2 &&
      !VOLATILE_CLASS.test(cls) &&
      !GENERIC_CLASS.test(cls) &&
      !GENERATED_CLASS.test(cls) &&
      !/^\d/.test(cls),
  );
}

function testIdSelector(el: Element): string | null {
  for (const attr of TEST_ID_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return `[${attr}="${cssEscape(value)}"]`;
  }
  return null;
}

/**
 * A structural path that is unique by construction. Anchored at the document
 * root - the previous version stopped short of `body` and emitted an unanchored
 * path that could match anywhere in the document.
 */
export function getStructuralPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const tag = safeTagName(current).toLowerCase();
    if (!tag) break;
    if (tag === 'html') {
      parts.unshift(tag);
      break;
    }
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    // Bound to a local so the closure keeps the loop's non-null narrowing.
    const node = current;
    const nodeTag = safeTagName(node);
    const siblings = Array.from(parent.children).filter((child) => safeTagName(child) === nodeTag);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    current = parent;
  }

  return parts.join(' > ');
}

/**
 * Best available selector, verified unique against `root` before being returned.
 */
export function getRobustSelector(el: Element, root: ParentNode = document): string {
  const testId = testIdSelector(el);
  if (testId && isUnique(testId, el, root)) return testId;

  const id = el.getAttribute('id');
  if (id) {
    const selector = `#${cssEscape(id)}`;
    if (isUnique(selector, el, root)) return selector;
  }

  const tag = safeTagName(el).toLowerCase();

  const name = el.getAttribute('name');
  if (name) {
    const selector = `${tag}[name="${cssEscape(name)}"]`;
    if (isUnique(selector, el, root)) return selector;
  }

  const classes = usefulClasses(el);
  if (classes.length > 0) {
    const selector = `${tag}.${classes.slice(0, 3).map(cssEscape).join('.')}`;
    if (isUnique(selector, el, root)) return selector;
  }

  // Guaranteed unique.
  return getStructuralPath(el);
}

/** Ordered alternatives tried at replay time when the primary selector misses. */
export function getFallbackSelectors(el: Element, primary: string): string[] {
  const selectors: string[] = [];
  const push = (selector: string | null) => {
    if (selector && selector !== primary && !selectors.includes(selector)) selectors.push(selector);
  };

  push(testIdSelector(el));

  const id = el.getAttribute('id');
  if (id) push(`#${cssEscape(id)}`);

  const tag = safeTagName(el).toLowerCase();
  const name = el.getAttribute('name');
  if (name) {
    push(`${tag}[name="${cssEscape(name)}"]`);
    push(`[name="${cssEscape(name)}"]`);
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) push(`${tag}[aria-label="${cssEscape(ariaLabel)}"]`);

  const type = el.getAttribute('type');
  if (type && (tag === 'input' || tag === 'button')) push(`${tag}[type="${cssEscape(type)}"]`);

  const classes = usefulClasses(el);
  if (classes.length > 0) push(`${tag}.${classes.slice(0, 3).map(cssEscape).join('.')}`);

  // Always last: never fails, but is the most brittle to layout change.
  push(getStructuralPath(el));

  return selectors;
}

export function buildTargetPayload(el: Element, root: ParentNode = document): TargetPayload {
  const selector = getRobustSelector(el, root);
  const dataTestId = TEST_ID_ATTRS.map((attr) => el.getAttribute(attr)).find(Boolean) ?? undefined;

  return {
    selector,
    fallbackSelectors: getFallbackSelectors(el, selector),
    id: el.getAttribute('id') || undefined,
    name: el.getAttribute('name') || undefined,
    dataTestId,
    targetTag: safeTagName(el).toLowerCase(),
    textSnippet: (el.textContent || '').trim().slice(0, 120) || undefined,
  };
}
