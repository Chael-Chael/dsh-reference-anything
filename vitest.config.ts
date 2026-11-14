import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The example third-party source imports the public SDK by its package
    // name; inside this repository that is the source, not a stale build.
    alias: {
      'dsh-reference-anything/sdk': fileURLToPath(new URL('./src/sdk.ts', import.meta.url)),
      'dsh-reference-anything/source': fileURLToPath(new URL('./src/reference-source.ts', import.meta.url)),
    },
  },
  test: {
    // `.tsx` too: the settings panel's own tests render React.
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx', 'tests/**/*.spec.mjs'],
    environment: 'node',
    server: {
      // The official primitives ship CSS-module imports from their published
      // package. Inline them so Node-based component tests use the same
      // official implementation as the browser bundle.
      deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] },
    },
  },
})
