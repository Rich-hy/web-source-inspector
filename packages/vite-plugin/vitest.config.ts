import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

function workspaceSource(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      '@web-source-inspector/compiler-core': workspaceSource('../compiler-core/src/index.ts'),
      '@web-source-inspector/dev-session-core': workspaceSource('../dev-session-core/src/index.ts'),
      '@web-source-inspector/protocol': workspaceSource('../protocol/src/index.ts'),
      '@web-source-inspector/runtime': workspaceSource('../runtime/src/index.ts'),
      '@web-source-inspector/transform-vue': workspaceSource('../transform-vue/src/index.ts'),
    },
  },
  test: {
    include: ['packages/vite-plugin/src/**/*.test.ts'],
    environment: 'node',
  },
});
