// Node types are pulled in only here. They are deliberately kept out of the
// global `types` list so browser code cannot reach for Node globals by accident.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `popup.ts` throws on load if any element it binds to is missing, which would
 * leave the popup completely blank. The behavioural tests in popup.test.ts run
 * against their own fixture, so on their own they would stay green while the
 * real index.html drifted. This suite checks the actual shipped markup.
 */

// Resolved from the project root: `import.meta.url` is an http URL under the
// jsdom test environment, not a file one.
const popupSource = readFileSync(resolve(process.cwd(), 'src/popup.ts'), 'utf8');
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

/** Every id popup.ts resolves through its throwing `el()` helper. */
function requiredIds(): string[] {
  const ids = new Set<string>();
  for (const match of popupSource.matchAll(/\bel<[^>]+>\('([^']+)'\)/g)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids].sort();
}

describe('popup markup contract', () => {
  it('finds the ids popup.ts depends on', () => {
    // Guards the extraction itself: a refactor that renamed `el()` would
    // otherwise silently reduce this suite to asserting nothing.
    expect(requiredIds().length).toBeGreaterThanOrEqual(15);
  });

  it.each(requiredIds())('index.html declares #%s', (id) => {
    expect(indexHtml).toContain(`id="${id}"`);
  });

  it('loads the popup entry module', () => {
    expect(indexHtml).toContain('src="/src/popup.ts"');
  });

  it('declares no inline event handlers', () => {
    // Inline handlers are blocked by the extension CSP; they would fail silently.
    expect(indexHtml).not.toMatch(/\son[a-z]+\s*=/i);
  });
});
