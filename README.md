# ReplayX

ReplayX is a deterministic web replay and debugging system built as a Chrome extension. It captures real user sessions, replays them in a controlled environment, and surfaces failures with structured diagnostics so teams can understand regressions, UI drift, and flaky interactions with far greater clarity than a traditional screen recording.

This project is designed for product engineers, QA teams, and frontend developers who need to reproduce bugs reliably, inspect interaction sequences, and debug asynchronous behavior without relying on brittle manual reproduction.

## Why ReplayX

Modern web applications are complex: stateful UIs, client-side routing, async network requests, DOM mutations, and timing-sensitive interactions make debugging difficult. ReplayX addresses this by turning a real session into a replayable artifact that can be inspected, resumed, and debugged.

Key outcomes include:
- Deterministic replay of recorded user behavior
- Better reproduction of hard-to-catch UI regressions
- Visibility into network-driven behavior and state changes
- Structured replay diagnostics for target misses, DOM mismatches, and playback failures
- A local-first workflow with no external service required

## Core capabilities

### Session recording
ReplayX records a broad set of user interactions including:
- Clicks and double clicks
- Text input and form changes
- Form submissions
- Keyboard input
- Scroll events
- Focus and blur
- Navigation events
- Resize events
- DOM mutations and initial page state

Each event is time-normalized and persisted with target metadata so replay can be reconstructed faithfully.

### Deterministic replay
The replay engine replays recorded sessions in order while attempting to recreate the original page behavior. It includes:
- Event scheduling with normalized timing
- Selector-based targeting for DOM interaction
- Navigation handling across pages
- Replay speed control and step-through execution
- State restoration for storage and session state
- Network-aware settling to reduce false positives during asynchronous UI updates

### Network-aware debugging
ReplayX intercepts fetch and XHR traffic and can replay recorded network behavior in a deterministic way. This improves reliability when a page depends on API responses, optimistic UI updates, or server-driven rendering.

### Replay diagnostics
The system records structured replay issues such as:
- Missing target elements
- Failed event execution
- DOM mismatch when the page remains effectively unchanged after an interaction
- Replay settling failures and other playback anomalies

These findings are surfaced in the popup debugger for rapid inspection.

## Architecture

ReplayX is implemented as a Manifest V3 Chrome extension with a layered architecture:

- Popup UI: session overview, replay controls, and debugger panel
- Background service worker: orchestration, state persistence, and session lifecycle management
- Content scripts: recording and replay execution inside the target page
- Main-world interceptor: fetch/XHR interception for deterministic network replay
- IndexedDB storage layer: persistent session and event storage

### Main modules
- [src/content/recorder.ts](src/content/recorder.ts): captures user interactions and builds the event stream
- [src/content/replayer.ts](src/content/replayer.ts): replays recorded sessions and collects diagnostics
- [src/content/interceptor.ts](src/content/interceptor.ts): intercepts network calls for recording and replay mocking
- [src/background/service_worker.ts](src/background/service_worker.ts): coordinates recording, replay, and persistence across the extension
- [src/popup.ts](src/popup.ts): renders the extension popup and debugger experience
- [src/storage/db.ts](src/storage/db.ts): stores sessions and events in IndexedDB
- [src/types.ts](src/types.ts): shared event, session, and replay error model
- [src/debugger.ts](src/debugger.ts): formats replay issues and event summaries for the UI

## Project structure

```text
src/
  background/
    service_worker.ts
  content/
    interceptor.ts
    main.ts
    recorder.ts
    replayer.ts
    replayer.test.ts
  storage/
    db.ts
  popup.ts
  popup.css
  debugger.ts
  types.ts
public/
  icons/
manifest.json
package.json
vite.config.ts
```

## How it works

1. Install and load the extension in Chrome.
2. Open a site and start recording from the popup.
3. Interact with the app as usual. ReplayX captures the session and persists it locally.
4. Stop recording and inspect the session in the popup.
5. Replay the session to reproduce behavior and analyze issues.
6. Use the debugger panel to inspect recent issues, timeline events, and network activity.

## Tech stack

- TypeScript
- Vite
- Vitest
- Chrome Extensions Manifest V3
- IndexedDB
- DOM MutationObserver
- fetch/XHR interception

## Getting started

### Prerequisites
- Node.js 18+
- npm
- Google Chrome

### Install dependencies

```bash
npm install
```

### Build the extension

```bash
npm run build
```

### Load in Chrome

1. Open Chrome and navigate to chrome://extensions.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select the generated dist directory. from this project.

### Run tests

```bash
npm test
```

### Start development mode

```bash
npm run dev
```

## Development notes

ReplayX is intentionally local-first. All session data is stored in the browser using IndexedDB, which makes it practical for debugging without a backend or remote service.

For the best replay fidelity:
- Prefer stable selectors and semantic markup
- Avoid nondeterministic UI behavior during recording
- Keep test data predictable when reproducing regressions

## Testing

The project includes regression tests for replay behavior in [src/content/replayer.test.ts](src/content/replayer.test.ts). These cover:
- Event scheduling normalization
- Replay speed behavior
- Navigation replay
- Click dispatching
- Failure context reporting
- DOM mismatch detection

## Roadmap

Potential enhancements include:
- More advanced DOM diffing and semantic mismatch analysis
- Richer timeline visualization and filtering
- Session export/import polish and sharing workflows
- Better support for complex single-page applications
- Optional cloud sync or remote debugging integrations

## License

This project is provided as a development and debugging utility for browser-based workflows.
