import { defineConfig } from 'tsup';

const internalPackages = [/^@web-source-inspector\//];

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node16',
    dts: false,
    clean: false,
    sourcemap: false,
    noExternal: internalPackages,
    banner: { js: '#!/usr/bin/env node' },
    outExtension: () => ({ js: '.cjs' }),
  },
  {
    entry: { 'webpack-loader': 'src/webpack-loader.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node16',
    dts: true,
    clean: false,
    sourcemap: false,
    noExternal: internalPackages,
    outExtension: () => ({ js: '.cjs' }),
  },
  {
    entry: { 'browser-runtime': 'src/browser-runtime.ts' },
    format: ['esm'],
    platform: 'browser',
    target: 'es2018',
    dts: true,
    clean: false,
    sourcemap: false,
    noExternal: internalPackages,
  },
]);
