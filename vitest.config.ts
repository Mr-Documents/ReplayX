import { defineConfig } from 'vitest/config';

// Deliberately does NOT extend vite.config.ts: the CRX plugin rewrites the
// manifest and emits extension bundles, which is irrelevant (and slow) for unit tests.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/vite-env.d.ts',
        'src/types.ts',
        // Extension entry points: pure chrome-API wiring with no branching logic
        // of their own. Their decision logic lives in router.ts / recorder.ts /
        // replayer.ts, which are covered directly.
        'src/background/service_worker.ts',
        'src/content/main.ts',
        'src/content/interceptor.entry.ts',
      ],
      // A ratchet, not an aspiration: raise these as coverage improves, never
      // lower them. Branches sit lower because the extension boundary is full
      // of defensive catch blocks whose failure modes cannot be provoked in
      // jsdom (sealed XHR instances, revoked storage, a dead extension context).
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
  },
});
