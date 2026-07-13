import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@web-source-inspector/compiler-core': fileURLToPath(
        new URL('../compiler-core/src/index.ts', import.meta.url),
      ),
      '@web-source-inspector/protocol': fileURLToPath(
        new URL('../protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/transform-vue/src/**/*.test.ts'],
    environment: 'node',
  },
});
