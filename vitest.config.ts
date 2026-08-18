import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `.tsx` too: the settings panel's own tests render React.
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
  },
})
