import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
    coverage: {
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts']
    }
  }
});
