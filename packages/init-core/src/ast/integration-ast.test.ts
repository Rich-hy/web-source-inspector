import { describe, expect, it } from 'vitest';
import { removeViteIntegration, transformViteConfig } from './vite';
import {
  removeVueCliIntegration,
  removeWebpackIntegration,
  transformVueCliConfig,
  transformWebpackConfig,
} from './webpack';

describe('Vite AST integration', () => {
  it('supports CommonJS Vue bindings and avoids a top-level binding collision', () => {
    const source = `const vue = require('@vitejs/plugin-vue')
const webSourceInspector = 42
module.exports = { plugins: [vue()] }
`;
    const result = transformViteConfig(source, 'commonjs');

    expect(result.ok).toBe(true);
    expect(result.code).toContain('webSourceInspectorWsi1');
    expect(result.code.indexOf('webSourceInspectorWsi1()')).toBeLessThan(
      result.code.indexOf('vue()'),
    );
  });

  it('moves a reused call before Vue and restores its prior position on remove', () => {
    const source = `import vue from '@vitejs/plugin-vue'
import { webSourceInspector } from 'web-source-inspector/vite'
export default { plugins: [vue(), webSourceInspector()] }
`;
    const result = transformViteConfig(source, 'esm');
    const pluginOperation = result.operations.find((item) => item.kind === 'plugin');

    expect(result.ok).toBe(true);
    expect(pluginOperation).toMatchObject({
      ownership: 'reused',
      details: { action: 'moved-before-vue' },
    });
    const removed = removeViteIntegration(result.code, result.operations);
    expect(removed.ok).toBe(true);
    expect(removed.code.indexOf('vue()')).toBeLessThan(
      removed.code.indexOf('webSourceInspector()'),
    );
  });

  it('restores a reused call by stable neighbors after unrelated reordering', () => {
    const source = `import vue from '@vitejs/plugin-vue'
import { webSourceInspector } from 'web-source-inspector/vite'
export default { plugins: [vue(), alpha(), webSourceInspector(), omega()] }
`;
    const result = transformViteConfig(source, 'esm');
    const reordered = result.code.replace(
      'plugins: [webSourceInspector(), vue(), alpha(), omega()]',
      'plugins: [webSourceInspector(), vue(), extra(), alpha(), omega()]',
    );

    expect(reordered).not.toBe(result.code);
    const removed = removeViteIntegration(reordered, result.operations);

    expect(removed.ok).toBe(true);
    expect(removed.code.indexOf('alpha()')).toBeLessThan(
      removed.code.indexOf('webSourceInspector()'),
    );
    expect(removed.code.indexOf('webSourceInspector()')).toBeLessThan(
      removed.code.indexOf('omega()'),
    );
  });

  it('rejects removal after a reused call moves away from its initialized position', () => {
    const source = `import vue from '@vitejs/plugin-vue'
import { webSourceInspector } from 'web-source-inspector/vite'
export default { plugins: [vue(), webSourceInspector()] }
`;
    const result = transformViteConfig(source, 'esm');
    const movedAgain = result.code.replace(
      'plugins: [webSourceInspector(), vue()]',
      'plugins: [vue(), webSourceInspector()]',
    );

    const removed = removeViteIntegration(movedAgain, result.operations);

    expect(movedAgain).not.toBe(result.code);
    expect(removed).toMatchObject({ ok: false, errorCode: 'INTEGRATION_STATE_CONFLICT' });
  });

  it('does not remove an initializer-created call after the user changes it', () => {
    const source = `import vue from '@vitejs/plugin-vue'
export default { plugins: [vue()] }
`;
    const result = transformViteConfig(source, 'esm');
    const changed = result.code.replace('webSourceInspector()', 'webSourceInspector({ enabled: true })');

    const removed = removeViteIntegration(changed, result.operations);

    expect(removed).toMatchObject({ ok: false, errorCode: 'INTEGRATION_STATE_CONFLICT' });
    expect(removed.code).toBe(changed);
  });

  it('rejects nested returns, spreads, and duplicate config properties', () => {
    const nestedReturn = transformViteConfig(`import vue from '@vitejs/plugin-vue'
export default () => {
  if (process.env.CI) return { plugins: [] }
  return { plugins: [vue()] }
}
`, 'esm');
    const spread = transformViteConfig(`import vue from '@vitejs/plugin-vue'
export default { ...shared, plugins: [vue()] }
`, 'esm');
    const duplicate = transformViteConfig(`import vue from '@vitejs/plugin-vue'
export default { plugins: [], plugins: [vue()] }
`, 'esm');

    expect(nestedReturn).toMatchObject({ ok: false, errorCode: 'CONFIG_SHAPE_UNSUPPORTED' });
    expect(spread).toMatchObject({ ok: false, errorCode: 'CONFIG_SHAPE_UNSUPPORTED' });
    expect(duplicate).toMatchObject({ ok: false, errorCode: 'CONFIG_SHAPE_UNSUPPORTED' });
  });

  it('rejects computed CommonJS exports', () => {
    const identifierExport = transformViteConfig(`const vue = require('@vitejs/plugin-vue')
module[exports] = { plugins: [vue()] }
`, 'commonjs');
    const stringExport = transformViteConfig(`const vue = require('@vitejs/plugin-vue')
module['exports'] = { plugins: [vue()] }
`, 'commonjs');

    expect(identifierExport).toMatchObject({ ok: false, errorCode: 'CONFIG_SHAPE_UNSUPPORTED' });
    expect(stringExport).toMatchObject({ ok: false, errorCode: 'CONFIG_SHAPE_UNSUPPORTED' });
  });
});

describe('Webpack AST integration', () => {
  const webpackSource = `const { VueLoaderPlugin } = require('vue-loader')
module.exports = {
  module: { rules: [{ test: /\\.vue$/, use: ['babel-loader', 'vue-loader'] }] },
  plugins: [new VueLoaderPlugin()]
}
`;

  it('adds raw Webpack plugin/loader and removes created nodes', () => {
    const result = transformWebpackConfig(webpackSource, {
      moduleKind: 'commonjs',
      allowedOrigin: 'http://localhost:8080',
    });

    expect(result.ok).toBe(true);
    expect(result.code).toContain('WebSourceInspectorWebpackPlugin.loaderPath');
    expect(result.code).toMatch(
      /use:\s*\[[\s\S]*WebSourceInspectorWebpackPlugin\.loaderPath[\s\S]*["']vue-loader["']/u,
    );
    expect(result.code).toContain('browserTransport: "raw"');
    expect(result.code).toContain('allowedOrigins: ["http://localhost:8080"]');
    const removed = removeWebpackIntegration(result.code, result.operations);
    expect(removed.ok).toBe(true);
    expect(removed.code).not.toContain('web-source-inspector/webpack');
    expect(removed.code).not.toContain('loaderPath');
  });

  it('adds an absent WDS hook, wraps static hooks, and rejects dynamic returns', () => {
    const result = transformWebpackConfig(webpackSource, {
      moduleKind: 'commonjs',
      webpackDevServerMajor: 4,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain('setupMiddlewares');
    expect(result.code).toContain('createWebSourceInspectorBrowserMiddleware');
    expect(result.code).toContain(
      'createWebSourceInspectorBrowserMiddleware(devServer.compiler)',
    );

    const wds3 = transformWebpackConfig(webpackSource, {
      moduleKind: 'commonjs',
      webpackDevServerMajor: 3,
    });
    expect(wds3.ok).toBe(true);
    expect(wds3.code).toContain(
      'createWebSourceInspectorBrowserMiddleware(server.compiler)',
    );
    expect(wds3.code).toMatch(/before:\s*function\s*\(app,\s*server\)/u);

    const safeWds4 = transformWebpackConfig(
      webpackSource.replace(
        'plugins: [new VueLoaderPlugin()]',
        'plugins: [new VueLoaderPlugin()], devServer: { setupMiddlewares(items, devServer) { return items } }',
      ),
      { moduleKind: 'commonjs', webpackDevServerMajor: 4 },
    );
    expect(safeWds4.ok).toBe(true);
    expect(safeWds4.code).toContain('createWebSourceInspectorBrowserMiddleware(devServer.compiler)');
    const replayedWds4 = transformWebpackConfig(safeWds4.code, {
      moduleKind: 'commonjs',
      webpackDevServerMajor: 4,
    });
    expect(replayedWds4.operations.map((operation) => operation.fingerprint))
      .toEqual(safeWds4.operations.map((operation) => operation.fingerprint));
    const safeWds3 = transformWebpackConfig(
      webpackSource.replace(
        'plugins: [new VueLoaderPlugin()]',
        'plugins: [new VueLoaderPlugin()], devServer: { before(app, server, compiler) {} }',
      ),
      { moduleKind: 'commonjs', webpackDevServerMajor: 3 },
    );
    expect(safeWds3.ok).toBe(true);
    expect(safeWds3.code).toContain(
      'createWebSourceInspectorBrowserMiddleware(server.compiler)',
    );

    const legacyWds3 = transformWebpackConfig(
      webpackSource.replace(
        'plugins: [new VueLoaderPlugin()]',
        `plugins: [new VueLoaderPlugin()], devServer: { before: function(app, server, compiler) {
          const webSourceInspectorMiddleware = createWebSourceInspectorBrowserMiddleware(compiler)
          if (webSourceInspectorMiddleware) {
            app.use(webSourceInspectorMiddleware)
          }
        } }`,
      ).replace(
        "const { VueLoaderPlugin } = require('vue-loader')",
        `const { VueLoaderPlugin } = require('vue-loader')
const { createWebSourceInspectorBrowserMiddleware } = require('web-source-inspector/webpack')`,
      ),
      { moduleKind: 'commonjs', webpackDevServerMajor: 3 },
    );
    expect(legacyWds3.ok).toBe(true);
    expect(legacyWds3.code).toMatch(/before:\s*function\s*\(app,\s*server\)/u);
    expect(legacyWds3.code).toContain(
      'createWebSourceInspectorBrowserMiddleware(server.compiler)',
    );
    expect(legacyWds3.code).not.toContain(
      'createWebSourceInspectorBrowserMiddleware(compiler)',
    );
    const restored = removeWebpackIntegration(safeWds4.code, safeWds4.operations);
    expect(restored.ok).toBe(true);
    expect(restored.code).toContain('setupMiddlewares(items, devServer)');
    expect(restored.code).not.toContain('createWebSourceInspectorBrowserMiddleware');

    const unsafe = transformWebpackConfig(
      webpackSource.replace(
        'plugins: [new VueLoaderPlugin()]',
        'plugins: [new VueLoaderPlugin()], devServer: { setupMiddlewares(items) { if (flag) return []; return items } }',
      ),
      { moduleKind: 'commonjs', webpackDevServerMajor: 4 },
    );
    expect(unsafe).toMatchObject({ ok: false, errorCode: 'WDS_HOOK_UNSAFE_TO_WRAP' });
  });

  it('rejects duplicate object properties in the Webpack whitelist', () => {
    const duplicate = transformWebpackConfig(
      webpackSource.replace(
        'plugins: [new VueLoaderPlugin()]',
        'plugins: [], plugins: [new VueLoaderPlugin()]',
      ),
      { moduleKind: 'commonjs', allowedOrigin: 'http://localhost:8080' },
    );

    expect(duplicate).toMatchObject({ ok: false, errorCode: 'CONFIG_SHAPE_UNSUPPORTED' });
  });

  it('rejects array holes and computed CommonJS exports', () => {
    const hole = transformWebpackConfig(
      webpackSource.replace(
        'plugins: [new VueLoaderPlugin()]',
        'plugins: [new VueLoaderPlugin(), ,]',
      ),
      { moduleKind: 'commonjs', allowedOrigin: 'http://localhost:8080' },
    );
    const computedExport = transformWebpackConfig(
      webpackSource.replace('module.exports', 'module[exports]'),
      { moduleKind: 'commonjs', allowedOrigin: 'http://localhost:8080' },
    );

    expect(hole).toMatchObject({ ok: false, errorCode: 'CONFIG_SHAPE_UNSUPPORTED' });
    expect(computedExport).toMatchObject({ ok: false, errorCode: 'CONFIG_SHAPE_UNSUPPORTED' });
  });

  it('does not remove a created WDS hook after the user extends it', () => {
    const result = transformWebpackConfig(webpackSource, {
      moduleKind: 'commonjs',
      webpackDevServerMajor: 4,
    });
    const changed = result.code.replace(
      'return middlewares;',
      'console.log("custom");\n      return middlewares;',
    );

    const removed = removeWebpackIntegration(changed, result.operations);

    expect(changed).not.toBe(result.code);
    expect(removed).toMatchObject({ ok: false, errorCode: 'INTEGRATION_STATE_CONFLICT' });
  });

  it('wraps one static WDS4 middleware statement without replacing the hook', () => {
    const source = webpackSource.replace(
      'plugins: [new VueLoaderPlugin()]',
      `plugins: [new VueLoaderPlugin()], devServer: {
  setupMiddlewares(middlewares, devServer) {
    middlewares.push({ name: 'existing', middleware: existingMiddleware })
    return middlewares
  }
}`,
    );
    const result = transformWebpackConfig(source, {
      moduleKind: 'commonjs',
      webpackDevServerMajor: 4,
    });

    expect(result.ok).toBe(true);
    expect(result.code.match(/existingMiddleware/gu)).toHaveLength(1);
    expect(result.code.indexOf('existingMiddleware')).toBeLessThan(
      result.code.indexOf('webSourceInspectorMiddleware'),
    );
    const removed = removeWebpackIntegration(result.code, result.operations);
    expect(removed.ok).toBe(true);
    expect(removed.code).toContain('existingMiddleware');
    expect(removed.code).not.toContain('createWebSourceInspectorBrowserMiddleware');
  });

  it('rejects WDS hooks that shadow generated or imported middleware bindings', () => {
    const localParameter = transformWebpackConfig(
      webpackSource.replace(
        'plugins: [new VueLoaderPlugin()]',
        'plugins: [new VueLoaderPlugin()], devServer: { setupMiddlewares(webSourceInspectorMiddleware, devServer) { return webSourceInspectorMiddleware } }',
      ),
      { moduleKind: 'commonjs', webpackDevServerMajor: 4 },
    );
    const importedParameter = transformWebpackConfig(
      webpackSource.replace(
        'plugins: [new VueLoaderPlugin()]',
        'plugins: [new VueLoaderPlugin()], devServer: { setupMiddlewares(middlewares, createWebSourceInspectorBrowserMiddleware) { return middlewares } }',
      ),
      { moduleKind: 'commonjs', webpackDevServerMajor: 4 },
    );
    const localReference = transformWebpackConfig(
      webpackSource.replace(
        'plugins: [new VueLoaderPlugin()]',
        `plugins: [new VueLoaderPlugin()], devServer: {
  setupMiddlewares(middlewares, devServer) {
    middlewares.push(webSourceInspectorMiddleware)
    return middlewares
  }
}`,
      ),
      { moduleKind: 'commonjs', webpackDevServerMajor: 4 },
    );

    expect(localParameter).toMatchObject({ ok: false, errorCode: 'WDS_HOOK_UNSAFE_TO_WRAP' });
    expect(importedParameter).toMatchObject({ ok: false, errorCode: 'WDS_HOOK_UNSAFE_TO_WRAP' });
    expect(localReference).toMatchObject({ ok: false, errorCode: 'WDS_HOOK_UNSAFE_TO_WRAP' });
  });

  it('inserts WDS3 owned middleware before an existing static app.use', () => {
    const source = webpackSource.replace(
      'plugins: [new VueLoaderPlugin()]',
      `plugins: [new VueLoaderPlugin()], devServer: {
  before(app, server, compiler) {
    app.use(existingMiddleware)
  }
}`,
    );
    const result = transformWebpackConfig(source, {
      moduleKind: 'commonjs',
      webpackDevServerMajor: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.code.indexOf('const webSourceInspectorMiddleware'))
      .toBeLessThan(result.code.indexOf('existingMiddleware'));
    expect(result.code.match(/existingMiddleware/gu)).toHaveLength(1);
    const replayed = transformWebpackConfig(result.code, {
      moduleKind: 'commonjs',
      webpackDevServerMajor: 3,
    });
    expect(replayed.operations.map((operation) => operation.fingerprint))
      .toEqual(result.operations.map((operation) => operation.fingerprint));
    const removed = removeWebpackIntegration(result.code, result.operations);
    expect(removed.ok).toBe(true);
    expect(removed.code).toContain('existingMiddleware');
    expect(removed.code).not.toContain('createWebSourceInspectorBrowserMiddleware');
  });
});

describe('Vue CLI AST integration', () => {
  it('creates and removes standard chainWebpack and WDS4 nodes', () => {
    const result = transformVueCliConfig('module.exports = {}\n', {
      moduleKind: 'commonjs',
      webpackDevServerMajor: 4,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toMatch(/module\.rule\(["']vue["']\)/u);
    expect(result.code).toMatch(/before\(["']vue-loader["']\)/u);
    expect(result.code).toContain('setupMiddlewares');
    expect(result.code).toContain(
      'createWebSourceInspectorBrowserMiddleware(devServer.compiler)',
    );
    const replayed = transformVueCliConfig(result.code, {
      moduleKind: 'commonjs',
      webpackDevServerMajor: 4,
    });
    expect(replayed.ok).toBe(true);
    expect(replayed.operations.map((operation) => operation.fingerprint))
      .toEqual(result.operations.map((operation) => operation.fingerprint));
    const removed = removeVueCliIntegration(result.code, result.operations);
    expect(removed.ok).toBe(true);
    expect(removed.code).not.toContain('web-source-inspector');
    expect(removed.code).not.toContain('chainWebpack');
  });

  it('does not remove a created chain statement after the user extends it', () => {
    const result = transformVueCliConfig('module.exports = {}\n', {
      moduleKind: 'commonjs',
      webpackDevServerMajor: 4,
    });
    const changed = result.code.replace(
      ".before('vue-loader')",
      ".before('vue-loader').after('custom-loader')",
    ).replace(
      '.before("vue-loader")',
      '.before("vue-loader").after("custom-loader")',
    );

    const removed = removeVueCliIntegration(changed, result.operations);

    expect(changed).not.toBe(result.code);
    expect(removed).toMatchObject({ ok: false, errorCode: 'INTEGRATION_STATE_CONFLICT' });
  });

  it('does not mistake arbitrary marker strings for an existing chain integration', () => {
    const source = `const { WebSourceInspectorWebpackPlugin } = require('web-source-inspector/webpack')
module.exports = {
  chainWebpack(config) {
    console.log(WebSourceInspectorWebpackPlugin, 'vue-loader', 'web-source-inspector')
  }
}
`;
    const result = transformVueCliConfig(source, {
      moduleKind: 'commonjs',
      webpackDevServerMajor: 4,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'CHAIN_WEBPACK_UNSUPPORTED' });
  });
});
