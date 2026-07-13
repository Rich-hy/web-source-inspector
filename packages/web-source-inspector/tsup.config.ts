import { defineConfig } from 'tsup';

const OPTIONAL_PEERS = [
  '@vitejs/plugin-vue',
  '@vitejs/plugin-vue2',
  '@vue/compiler-dom',
  '@vue/compiler-sfc',
  'vite',
  'vite-plugin-vue2',
  'vue',
  'vue-loader',
  'vue-template-compiler',
  'webpack',
  'webpack-dev-server',
];

const CJS_MODULE_URL_IDENTIFIER = '__wsiCjsModuleUrl';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    vite: 'src/vite.ts',
    webpack: 'src/webpack.ts',
  },
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node16',
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  external: OPTIONAL_PEERS,
  noExternal: [/^@web-source-inspector\//],
  banner({ format }) {
    if (format !== 'cjs') {
      return undefined;
    }
    return {
      js: `"use strict";\nconst ${CJS_MODULE_URL_IDENTIFIER} = require('node:url').pathToFileURL(__filename).href;`,
    };
  },
  esbuildOptions(options, { format }) {
    if (format !== 'cjs') {
      return;
    }
    // CJS 没有 import.meta.url，在编译期绑定到每个输出 bundle 自己的 __filename。
    options.define = {
      ...options.define,
      'import.meta.url': CJS_MODULE_URL_IDENTIFIER,
    };
    options.logOverride = {
      ...options.logOverride,
      'empty-import-meta': 'error',
    };
  },
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
