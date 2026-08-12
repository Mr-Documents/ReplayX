import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' with { type: 'json' };

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    // Chrome Web Store review flags minified-but-unmapped code; keeping the
    // sourcemap makes the uploaded bundle reviewable.
    sourcemap: true,
    target: 'chrome116',
  },
});
