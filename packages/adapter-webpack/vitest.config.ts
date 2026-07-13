import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@web-source-inspector/compiler-core': fileURLToPath(
        new URL('../compiler-core/src/index.ts', import.meta.url),
      ),
      '@web-source-inspector/dev-session-core': fileURLToPath(
        new URL('../dev-session-core/src/index.ts', import.meta.url),
      ),
      '@web-source-inspector/protocol': fileURLToPath(
        new URL('../protocol/src/index.ts', import.meta.url),
      ),
      '@web-source-inspector/transform-vue': fileURLToPath(
        new URL('../transform-vue/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/adapter-webpack/src/**/*.test.ts'],
    environment: 'node',
  },
});
