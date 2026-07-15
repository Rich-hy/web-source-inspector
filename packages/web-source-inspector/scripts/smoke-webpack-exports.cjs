const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const packageRoot = path.resolve(__dirname, '..');
const distDirectory = path.join(packageRoot, 'dist');
const expectedLoaderPath = path.join(distDirectory, 'webpack-loader.cjs');
const registrySymbol = Symbol.for('web-source-inspector.adapter-webpack.registry');

class MockHook {
  callbacks = [];

  tap(_name, callback) {
    this.callbacks.push(callback);
  }

  call(...arguments_) {
    for (const callback of this.callbacks) {
      callback(...arguments_);
    }
  }
}

class VueLoaderPlugin {}

function assertLoaderPath(moduleExports, format) {
  const actualLoaderPath = moduleExports.WebSourceInspectorWebpackPlugin.loaderPath;
  assert.equal(
    actualLoaderPath,
    expectedLoaderPath,
    `${format} loaderPath 必须指向公开包内的 webpack-loader.cjs`,
  );
  assert.equal(path.isAbsolute(actualLoaderPath), true, `${format} loaderPath 必须是绝对路径`);
  assert.equal(fs.existsSync(actualLoaderPath), true, `${format} loaderPath 必须真实存在`);
}

function createCompiler(context, loaderPath, compilerVersion) {
  const hooks = {
    afterPlugins: new MockHook(),
    thisCompilation: new MockHook(),
    done: new MockHook(),
    failed: new MockHook(),
    invalid: new MockHook(),
    watchClose: new MockHook(),
    shutdown: new MockHook(),
  };
  const compiler = {
    options: {
      mode: 'development',
      context,
      module: {
        rules: [{ test: /\.vue$/, use: [loaderPath, 'vue-loader'] }],
      },
      plugins: [new VueLoaderPlugin()],
    },
    hooks,
  };
  if (compilerVersion !== null) {
    compiler.webpack = { version: compilerVersion };
  }
  return { compiler, hooks };
}

function assertPhysicalBundleRegistry(moduleExports) {
  const loaderModule = require(expectedLoaderPath);
  assert.equal(typeof loaderModule.default, 'function', '物理 webpack-loader.cjs 必须导出 Loader');
  const { compiler, hooks } = createCompiler(
    packageRoot,
    expectedLoaderPath,
    '5.99.0',
  );
  new moduleExports.WebSourceInspectorWebpackPlugin({
    vueLoaderMajor: 17,
    browserTransport: 'none',
  }).apply(compiler);

  const loaderContext = {
    // source-boundary 只转换可 realpath 的工作区源码，使用真实 fixture 避免把失效路径误当作 session 回归。
    resourcePath: path.join(packageRoot, '..', '..', 'fixtures', 'vue-webpack-basic', 'src', 'App.vue'),
    resourceQuery: '?vue&type=template&id=smoke',
    loaderIndex: 0,
    loaders: [],
    _compiler: compiler,
    _module: {},
  };
  assert.throws(
    () => loaderModule.default.call(loaderContext, '<div />'),
    /WSI template Loader 必须运行在 Webpack async loader 上下文/,
    'Plugin bundle 创建的 session 必须能被物理 Loader bundle 取得',
  );
  hooks.watchClose.call();
  assert.equal(
    loaderModule.default.call(loaderContext, '<div />'),
    '<div />',
    'Plugin dispose 后物理 Loader bundle 不得继续读取旧 session',
  );
}

function assertWebpack4Fallback(commonJsModule) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsi-public-webpack4-'));
  const webpackDirectory = path.join(temporaryRoot, 'node_modules', 'webpack');
  fs.mkdirSync(webpackDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(webpackDirectory, 'package.json'),
    JSON.stringify({ name: 'webpack', version: '4.47.0' }),
    'utf8',
  );
  const { compiler, hooks } = createCompiler(temporaryRoot, expectedLoaderPath, null);
  try {
    new commonJsModule.WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 15,
      browserTransport: 'none',
    }).apply(compiler);
    const registry = globalThis[registrySymbol];
    assert.equal(
      registry?.compilerSessions?.get(compiler)?.compilerVersion,
      '4.47.0',
      '公开 CJS bundle 必须从消费项目解析 Webpack 4 版本',
    );
  } finally {
    hooks.watchClose.call();
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    assert.match(path.basename(temporaryRoot), /^wsi-public-webpack4-/);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const commonJsEntryPath = path.join(distDirectory, 'webpack.cjs');
  assert.match(
    fs.readFileSync(commonJsEntryPath, 'utf8'),
    /^["']use strict["'];/,
    'CommonJS bundle 必须保留 strict mode directive prologue',
  );
  for (const typeFile of ['webpack.d.ts', 'webpack.d.cts', 'webpack-loader.d.cts']) {
    assert.equal(fs.existsSync(path.join(distDirectory, typeFile)), true, `${typeFile} 必须存在`);
  }
  const commonJsModule = require(commonJsEntryPath);
  assertLoaderPath(commonJsModule, 'CommonJS require');
  assertPhysicalBundleRegistry(commonJsModule);
  assertWebpack4Fallback(commonJsModule);

  const webpackEntryUrl = pathToFileURL(path.join(distDirectory, 'webpack.js')).href;
  const originalGlobalFilename = globalThis.__filename;
  globalThis.__filename = path.join(packageRoot, 'consumer.cjs');
  try {
    const esmModule = await import(webpackEntryUrl);
    assertLoaderPath(esmModule, 'ESM import with polluted global');
    assertPhysicalBundleRegistry(esmModule);
  } finally {
    if (originalGlobalFilename === undefined) {
      delete globalThis.__filename;
    } else {
      globalThis.__filename = originalGlobalFilename;
    }
  }

  const pureEsmCheck = [
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `import { WebSourceInspectorWebpackPlugin } from ${JSON.stringify(webpackEntryUrl)};`,
    `const expected = ${JSON.stringify(expectedLoaderPath)};`,
    "assert.equal(WebSourceInspectorWebpackPlugin.loaderPath, expected);",
    "assert.equal(path.isAbsolute(WebSourceInspectorWebpackPlugin.loaderPath), true);",
    "assert.equal(fs.existsSync(WebSourceInspectorWebpackPlugin.loaderPath), true);",
  ].join('\n');
  const pureEsmResult = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', pureEsmCheck],
    { encoding: 'utf8' },
  );
  assert.equal(
    pureEsmResult.status,
    0,
    `纯 ESM 校验失败：${pureEsmResult.stderr || pureEsmResult.stdout}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
