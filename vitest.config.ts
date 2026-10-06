import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `.tsx` too: the settings panel's own tests render React.
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    server: {
      // The official primitives ship CSS-module imports from their published
      // package. Inline them so Node-based component tests use the same
      // official implementation as the browser bundle.
      deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] },
    },
  },
})
