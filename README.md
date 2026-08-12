# ReplayX

ReplayX is a deterministic web replay and debugging system built as a Chrome extension (Manifest V3). It captures real user sessions, replays them in a controlled environment, and surfaces failures with structured diagnostics so teams can understand regressions, UI drift, and flaky interactions with far greater clarity than a screen recording.

It is aimed at product engineers, QA teams, and frontend developers who need to reproduce bugs reliably, inspect interaction sequences, and debug asynchronous behaviour without brittle manual reproduction.

## Why ReplayX

Modern web apps are stateful, asynchronous, and timing-sensitive, which makes bugs hard to reproduce. ReplayX turns a real session into a replayable artefact that can be inspected, resumed, and debugged.

- Deterministic replay of recorded user behaviour
- Reproduction of hard-to-catch UI regressions
- Visibility into network-driven behaviour and state changes
- Structured replay diagnostics for target misses, DOM mismatches, and playback failures
- Local-first: no backend, no external service, no telemetry

## Core capabilities

### Session recording

Captures clicks and double clicks, text input and form changes, form submissions, keyboard input (keydown and keyup tracked separately), scroll, focus/blur, navigation (including SPA `pushState`/`replaceState`), resize, DOM mutations, and fetch/XHR traffic.

Each event is time-normalised against the session start, tagged with the frame it was captured in, and assigned a monotonic sequence number so recording order survives storage and reload.

**Privacy is enforced at capture time.** Password fields, fields whose name or id looks credential-shaped, and anything marked `data-replay-mask` are replaced with a mask before the value ever leaves the page — on both `input` and `change`. Authorization-style headers are dropped and credential-shaped JSON and form-encoded body fields are masked inside the network interceptor.

### Deterministic replay

- Event scheduling with normalised timing and a stable tie-break on recording order
- Multi-strategy element resolution: test ids, ids, names, ARIA labels, stable classes, and a structural path, plus shadow-DOM piercing and text-content matching
- Framework-safe value writes that bypass React/Vue setter interception
- Navigation handling across pages, with progress checkpointed so replay resumes after each load
- Replay speed control and single-step execution
- Selective storage restoration: only keys the recording captured are touched, so unrelated data survives
- Network-aware settling that waits for real quiescence before judging an outcome

### Network-aware debugging

fetch and XMLHttpRequest are intercepted in the page's MAIN world. During recording, exchanges are captured (with credentials stripped and bodies truncated); during replay, recorded responses are served back so pages that depend on API data behave as they did originally. When idle, the interceptor is fully transparent.

### Replay diagnostics

Structured findings for missing targets, failed event execution, and DOM mismatches. A mismatch is only reported when the original recording showed the DOM changing after that interaction and replay produced no change — so the report reflects real drift rather than every interaction that happens not to mutate the DOM.

## Architecture

| Layer | Module | Responsibility |
| --- | --- | --- |
| Popup UI | [src/popup.ts](src/popup.ts) | Session list, replay controls, debugger panel |
| Background entry | [src/background/service_worker.ts](src/background/service_worker.ts) | Chrome API adapter and worker lifecycle only |
| Background logic | [src/background/router.ts](src/background/router.ts) | All orchestration, dependency-injected and unit tested |
| Background state | [src/background/state.ts](src/background/state.ts) | State that survives MV3 worker suspension |
| Content entry | [src/content/main.ts](src/content/main.ts) | Wires recorder, replayer, widget, interceptor bridge |
| Recording | [src/content/recorder.ts](src/content/recorder.ts) | Interaction capture, masking, rate limiting |
| Replay | [src/content/replayer.ts](src/content/replayer.ts) | Playback, settling, diagnostics |
| Selectors | [src/content/selector.ts](src/content/selector.ts) | Uniqueness-verified selector generation |
| Interception | [src/content/interceptor.ts](src/content/interceptor.ts) | MAIN-world fetch/XHR hooks |
| Storage | [src/storage/db.ts](src/storage/db.ts) | IndexedDB session and chunked event storage |
| Protocol | [src/messages.ts](src/messages.ts) | Typed contracts for all three message channels |
| Validation | [src/validation.ts](src/validation.ts) | Import validation and sanitisation |

### Design notes

**The background is split in two.** `service_worker.ts` is a thin chrome-API adapter; every decision lives in `router.ts` behind injected `db` and `tabs` interfaces. That is what makes the background logic testable without a browser.

**Recording state is durable.** MV3 tears the service worker down after ~30 seconds idle, so recording and replay state live in `chrome.storage.session` and flushed events are appended straight to IndexedDB rather than buffered in worker memory.

**Three message channels, one contract.** Popup→background, background→content, and content↔interceptor are all typed in `messages.ts`. The interceptor channel runs over `window.postMessage`, which the host page can also write to, so every message on it is origin-checked and shape-validated.

**The popup builds DOM, never HTML.** Everything it renders comes from a recorded page or an imported file. All of it is inserted with `createElement` and `textContent`.

## Project structure

```text
src/
  background/
    service_worker.ts    router.ts    state.ts
  content/
    main.ts    recorder.ts    replayer.ts
    interceptor.ts    interceptor.entry.ts    selector.ts
  storage/
    db.ts
  popup.ts    popup.css    debugger.ts
  messages.ts    types.ts    validation.ts
test/
  setup.ts
.github/workflows/ci.yml
manifest.json    vite.config.ts    vitest.config.ts    eslint.config.js
```

## Getting started

### Prerequisites

- Node.js 20.19+ (see [.nvmrc](.nvmrc); `nvm use` picks the right version)
- npm
- Google Chrome 116+

### Install and build

```bash
npm install
npm run build
```

### Load in Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Choose **Load unpacked**
4. Select the generated `dist/` directory

### Development

```bash
npm run dev            # Vite dev server with hot reload
npm test               # Vitest in watch mode
npm run test:run       # Single test run
npm run test:coverage  # Tests with coverage thresholds enforced
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint
npm run verify         # typecheck + lint + coverage + build (what CI runs)
```

## How it works

1. Load the extension and open a site.
2. Start recording from the popup. The session record is created before capture begins, so events are durable from the first one.
3. Interact with the app. Events are buffered in the page and flushed to IndexedDB periodically and on unload.
4. Stop recording; the session appears in the popup list.
5. Replay it to reproduce the behaviour, at any speed or one step at a time.
6. Open **View** for the debugger panel: replay issues, event timeline, and network log.

## Testing

229 tests across 10 files, run against jsdom with an in-memory IndexedDB and a `chrome.*` stub:

| Suite | Focus |
| --- | --- |
| `storage/db.test.ts` | CRUD, chunking, append, retention, duration maths |
| `background/router.test.ts` | Every message action, failure and rollback paths |
| `background/state.test.ts` | Persistence across worker suspension, concurrent patches |
| `content/selector.test.ts` | Selector uniqueness, CSS escaping, structural paths |
| `content/recorder.test.ts` | Capture, masking, debouncing, limits |
| `content/replayer.test.ts` | Scheduling, execution, element resolution, mismatch attribution |
| `content/interceptor.test.ts` | fetch/XHR hooks, mock matching, sanitisation |
| `popup.test.ts` | Rendering, and that hostile recorded content stays inert |
| `validation.test.ts` | Import schema and sanitisation |
| `debugger.test.ts` | Event summaries |

Coverage thresholds are enforced in [vitest.config.ts](vitest.config.ts) and are a ratchet: raise them, never lower them.

## Continuous integration

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push and pull request to `main`:

- Typecheck, lint, and tests with coverage on Node 20.19, 22, and 24
- Production build, plus a structural check that `dist/manifest.json` is valid MV3 with a service worker and a MAIN-world content script
- `npm audit --audit-level=high` as a separate job
- Coverage and the built extension uploaded as artefacts

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Session state that survives service-worker suspension |
| `scripting` | Injecting the content script into tabs loaded before install |
| `activeTab` | Resolving the tab to record or replay |
| `alarms` | Scheduling the data-retention sweep |
| `host_permissions: http/https` | Recording and replaying on the pages you choose |

The extension declares no `downloads` permission: session export builds the file in the popup, which is a DOM context, rather than in the service worker.

## Data handling

All data stays in your browser's IndexedDB. Retention is enforced automatically: sessions older than 30 days are deleted, and at most 100 sessions are kept (newest first). See [PRIVACY.md](PRIVACY.md).

## Roadmap

- Semantic DOM diffing beyond structural fingerprints
- Richer timeline visualisation and filtering
- Cross-frame recording (`all_frames` is currently off by design)
- Better support for complex single-page applications

## License

Provided as a development and debugging utility for browser-based workflows.
