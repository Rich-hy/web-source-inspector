import {
  createSourceDigest,
  type SourceRecord,
} from '@web-source-inspector/compiler-core';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';

import { WSI_BUILD_METADATA_KEY } from './constants.js';
import { WebSourceInspectorWebpackPlugin } from './plugin.js';
import { getWebpackAdapterSession } from './registry.js';
import type {
  WebpackCompilationLike,
  WebpackCompilerLike,
  WebpackModuleLike,
  WebpackStatsLike,
  WsiBuildMetadata,
} from './types.js';

class MockHook<TArguments extends unknown[]> {
  readonly callbacks: Array<(...arguments_: TArguments) => void> = [];

  tap(_name: string, callback: (...arguments_: TArguments) => void): void {
    this.callbacks.push(callback);
  }

  call(...arguments_: TArguments): void {
    for (const callback of this.callbacks) {
      callback(...arguments_);
    }
  }
}

class VueLoaderPlugin {
  static readonly NS = 'vue-loader';

  apply(): void {}
}

function createDevelopmentCompiler(): {
  compiler: WebpackCompilerLike;
  hooks: ReturnType<typeof createCompilerHooks>;
  ruleUse: Array<string | { loader: string; options?: unknown }>;
} {
  const hooks = createCompilerHooks();
  const ruleUse: Array<string | { loader: string; options?: unknown }> = [
    WebSourceInspectorWebpackPlugin.loaderPath,
    'C:/workspace/node_modules/vue-loader/dist/index.js',
  ];
  const compiler = {
    options: {
      mode: 'development',
      context: 'C:/workspace',
      module: { rules: [{ test: /\.vue$/, use: ruleUse }] },
      plugins: [new VueLoaderPlugin()],
    },
    webpack: { version: '5.99.0' },
    hooks,
  } as unknown as WebpackCompilerLike;
  return { compiler, hooks, ruleUse };
}

function createCompilerHooks() {
  return {
    afterPlugins: new MockHook<[WebpackCompilerLike]>(),
    thisCompilation: new MockHook<[WebpackCompilationLike]>(),
    done: new MockHook<[WebpackStatsLike]>(),
    failed: new MockHook<[Error]>(),
    invalid: new MockHook<[]>(),
    watchClose: new MockHook<[]>(),
    shutdown: new MockHook<[]>(),
  };
}

function createCompilation() {
  const finishModules = new MockHook<[Iterable<WebpackModuleLike>]>();
  const compilation: WebpackCompilationLike = {
    hooks: { finishModules },
    modules: [],
    errors: [],
  };
  return { compilation, finishModules };
}

describe('WebSourceInspectorWebpackPlugin', () => {
  it('识别真实 vue-loader 导出的 Plugin 包装类', () => {
    class Plugin {
      static readonly NS = 'vue-loader';

      apply(): void {}
    }
    const { compiler, hooks } = createDevelopmentCompiler();
    if (!compiler.options) {
      throw new Error('测试 compiler options 不存在');
    }
    compiler.options.plugins = [new Plugin()];

    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      browserTransport: 'none',
    }).apply(compiler);

    expect(() => hooks.afterPlugins.call(compiler)).not.toThrow();
    hooks.watchClose.call();
  });

  it('production apply 严格 no-op，constructor 不提前校验或创建 session', () => {
    const hooks = createCompilerHooks();
    const compiler = {
      options: { mode: 'production' },
      hooks,
    } as unknown as WebpackCompilerLike;
    const plugin = new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      allowedOrigins: ['*'],
    });

    plugin.apply(compiler);

    expect(getWebpackAdapterSession(compiler)).toBeNull();
    expect(hooks.thisCompilation.callbacks).toHaveLength(0);
    expect(hooks.done.callbacks).toHaveLength(0);
  });

  it('真实 MultiCompiler parent 含 development child 时显式阻断', () => {
    const compiler = {
      compilers: [
        { options: { mode: 'production' } },
        { options: { mode: 'development' } },
      ],
    } as unknown as WebpackCompilerLike;
    expect(() =>
      new WebSourceInspectorWebpackPlugin({ vueLoaderMajor: 17 }).apply(compiler),
    ).toThrow(/MultiCompiler/);
  });

  it('真实 MultiCompiler parent 的 child 全非 development 时严格 no-op', () => {
    const hooks = createCompilerHooks();
    const compiler = {
      compilers: [
        { options: { mode: 'production' } },
        { options: {} },
      ],
      hooks,
    } as unknown as WebpackCompilerLike;

    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      allowedOrigins: ['*'],
    }).apply(compiler);

    expect(getWebpackAdapterSession(compiler)).toBeNull();
    expect(hooks.thisCompilation.callbacks).toHaveLength(0);
    expect(hooks.done.callbacks).toHaveLength(0);
  });

  it('Webpack 4 compiler 无 version 字段时从项目 package 解析可靠版本', () => {
    const pluginSource = readFileSync(
      fileURLToPath(new URL('./plugin.ts', import.meta.url)),
      'utf8',
    );
    expect(pluginSource).not.toContain('import.meta');

    const root = mkdtempSync(path.join(tmpdir(), 'wsi-webpack4-'));
    const webpackPackageDirectory = path.join(root, 'node_modules', 'webpack');
    mkdirSync(webpackPackageDirectory, { recursive: true });
    writeFileSync(
      path.join(webpackPackageDirectory, 'package.json'),
      JSON.stringify({ name: 'webpack', version: '4.47.0' }),
      'utf8',
    );
    const { compiler, hooks } = createDevelopmentCompiler();
    if (!compiler.options) {
      throw new Error('测试 compiler options 不存在');
    }
    compiler.options.context = root;
    delete compiler.webpack;
    delete compiler.version;

    try {
      new WebSourceInspectorWebpackPlugin({
        vueLoaderMajor: 15,
        browserTransport: 'none',
      }).apply(compiler);
      expect(getWebpackAdapterSession(compiler)?.compilerVersion).toBe('4.47.0');
    } finally {
      hooks.watchClose.call();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('在声明为真实项目的工具链不兼容时创建 session 前阻断', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wsi-webpack-preflight-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      dependencies: {
        vue: '3.5.0',
        webpack: '6.0.0',
        'vue-loader': '17.4.2',
      },
    }), 'utf8');
    for (const [name, version] of [
      ['vue', '3.5.0'],
      ['webpack', '6.0.0'],
      ['vue-loader', '17.4.2'],
    ] as const) {
      const directory = path.join(root, 'node_modules', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
        name,
        version,
      }), 'utf8');
    }
    const { compiler } = createDevelopmentCompiler();
    if (!compiler.options) {
      throw new Error('测试 compiler options 不存在');
    }
    compiler.options.context = root;

    expect(() => new WebSourceInspectorWebpackPlugin({
      browserTransport: 'none',
    }).apply(compiler)).toThrow(/兼容合同/u);
  });

  it('从 workspace hoisted node_modules 读取项目锚定的 Webpack/Vue facts', () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'wsi-webpack-hoisted-'));
    onTestFinished(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    const projectRoot = path.join(workspaceRoot, 'apps', 'demo');
    writeJson(path.join(workspaceRoot, 'package.json'), {
      private: true,
      workspaces: ['apps/*'],
    });
    writeJson(path.join(projectRoot, 'package.json'), {
      name: 'demo',
      devDependencies: {
        vue: '3.5.0',
        webpack: '5.99.0',
        'vue-loader': '17.4.2',
      },
    });
    writeNodePackage(workspaceRoot, 'vue', { name: 'vue', version: '3.5.0' });
    writeNodePackage(workspaceRoot, 'webpack', { name: 'webpack', version: '5.99.0' });
    writeNodePackage(workspaceRoot, 'vue-loader', {
      name: 'vue-loader',
      version: '17.4.2',
      peerDependencies: { webpack: '>=4.0.0 <6.0.0' },
    });
    writeNodePackage(workspaceRoot, '@vue/compiler-sfc', {
      name: '@vue/compiler-sfc',
      version: '3.5.0',
    }, 'exports.parse = () => ({ descriptor: {}, errors: [] });');
    writeNodePackage(workspaceRoot, '@vue/compiler-dom', {
      name: '@vue/compiler-dom',
      version: '3.5.0',
    }, 'exports.parse = () => ({ children: [] });');

    const { compiler, hooks } = createDevelopmentCompiler();
    if (!compiler.options) {
      throw new Error('测试 compiler options 不存在');
    }
    compiler.options.context = projectRoot;
    const diagnostics: string[] = [];
    const plugin = new WebSourceInspectorWebpackPlugin({
      projectRoot,
      browserTransport: 'none',
      diagnostics: (message) => diagnostics.push(message),
    });

    try {
      expect(() => plugin.apply(compiler)).not.toThrow();
      expect(getWebpackAdapterSession(compiler)).not.toBeNull();
      expect(diagnostics).toContain('PACKAGE_MANAGER_UNDETERMINED');
    } finally {
      hooks.watchClose.call();
    }
  });

  it('真实声明 Vue/Webpack 但缺少 vue-loader 时以 TOOLCHAIN_UNSUPPORTED 阻断', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'wsi-webpack-missing-loader-'));
    onTestFinished(() => rmSync(projectRoot, { recursive: true, force: true }));
    writeJson(path.join(projectRoot, 'package.json'), {
      name: 'missing-loader',
      devDependencies: {
        vue: '3.5.0',
        webpack: '5.99.0',
      },
    });
    writeNodePackage(projectRoot, 'vue', { name: 'vue', version: '3.5.0' });
    writeNodePackage(projectRoot, 'webpack', { name: 'webpack', version: '5.99.0' });
    writeNodePackage(projectRoot, '@vue/compiler-sfc', {
      name: '@vue/compiler-sfc',
      version: '3.5.0',
    }, 'exports.parse = () => ({ descriptor: {}, errors: [] });');
    writeNodePackage(projectRoot, '@vue/compiler-dom', {
      name: '@vue/compiler-dom',
      version: '3.5.0',
    }, 'exports.parse = () => ({ children: [] });');

    const { compiler, hooks } = createDevelopmentCompiler();
    if (!compiler.options) {
      throw new Error('测试 compiler options 不存在');
    }
    compiler.options.context = projectRoot;
    const diagnostics: string[] = [];
    let error: unknown;
    try {
      new WebSourceInspectorWebpackPlugin({
        projectRoot,
        vueLoaderMajor: 17,
        browserTransport: 'none',
        diagnostics: (message) => diagnostics.push(message),
      }).apply(compiler);
    } catch (caught) {
      error = caught;
    } finally {
      hooks.watchClose.call();
    }

    expect(error).toMatchObject({ code: 'TOOLCHAIN_UNSUPPORTED' });
    expect(diagnostics).toContain('VUE_LOADER_MISSING');
  });

  it('旁路 vue-loader pitcher 代理模块', () => {
    const { compiler, hooks } = createDevelopmentCompiler();
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      browserTransport: 'none',
    }).apply(compiler);

    const pitcherCompilation = createCompilation();
    hooks.thisCompilation.call(pitcherCompilation.compilation);
    const pitcherModules: WebpackModuleLike[] = [
      {
        resource: 'C:/workspace/src/App.vue?vue&type=template&id=abc',
        loaders: [{ loader: 'C:/workspace/node_modules/vue-loader/dist/pitcher.js' }],
        buildInfo: {},
      },
      {
        resource: 'C:/workspace/src/App.vue?vue&type=template&id=abc',
        loaders: [{ loader: 'C:/workspace/node_modules/vue-loader/lib/loaders/pitcher.js' }],
        buildInfo: {},
      },
    ];
    pitcherCompilation.compilation.modules = pitcherModules;
    pitcherCompilation.finishModules.call(pitcherModules);

    expect(pitcherCompilation.compilation.errors).toEqual([]);
    hooks.done.call({
      compilation: pitcherCompilation.compilation,
      hasErrors: () => false,
    });
    hooks.watchClose.call();
  });

  it('Pug/external src 缺少 metadata 时旁路，普通 HTML 仍 fail-closed', () => {
    const { compiler, hooks } = createDevelopmentCompiler();
    const root = mkdtempSync(path.join(tmpdir(), 'wsi-webpack-plugin-boundary-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const appPath = path.join(root, 'src', 'App.vue');
    mkdirSync(path.dirname(appPath), { recursive: true });
    writeFileSync(appPath, '<template><div /></template>', 'utf8');
    if (!compiler.options) {
      throw new Error('测试 compiler options 不存在');
    }
    compiler.options.context = root;
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      browserTransport: 'none',
    }).apply(compiler);

    for (const resource of [
      `${appPath}?vue&type=template&id=abc&lang=pug`,
      `${appPath}?vue&type=template&id=abc&src=true`,
    ]) {
      const unsupportedCompilation = createCompilation();
      hooks.thisCompilation.call(unsupportedCompilation.compilation);
      const unsupportedTemplateModule: WebpackModuleLike = { resource, buildInfo: {} };
      unsupportedCompilation.compilation.modules = [unsupportedTemplateModule];
      unsupportedCompilation.finishModules.call([unsupportedTemplateModule]);

      expect(unsupportedCompilation.compilation.errors).toEqual([]);
      hooks.done.call({
        compilation: unsupportedCompilation.compilation,
        hasErrors: () => false,
      });
    }

    const htmlCompilation = createCompilation();
    hooks.thisCompilation.call(htmlCompilation.compilation);
    const htmlTemplateModule: WebpackModuleLike = {
      resource: `${appPath}?vue&type=template&id=abc`,
      buildInfo: {},
    };
    htmlCompilation.compilation.modules = [htmlTemplateModule];
    htmlCompilation.finishModules.call([htmlTemplateModule]);
    expect(htmlCompilation.compilation.errors[0]?.message).toMatch(/缺少 WSI build metadata/);
    hooks.watchClose.call();
  });

  it('metadata collector 对第三方 template 使用 source boundary 旁路并清理旧 metadata', () => {
    const { compiler, hooks } = createDevelopmentCompiler();
    const root = mkdtempSync(path.join(tmpdir(), 'wsi-webpack-plugin-dependency-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const dependencyPath = path.join(root, 'node_modules', 'dependency', 'Dependency.vue');
    mkdirSync(path.dirname(dependencyPath), { recursive: true });
    writeFileSync(dependencyPath, '<template><div /></template>', 'utf8');
    if (!compiler.options) {
      throw new Error('测试 compiler options 不存在');
    }
    compiler.options.context = root;
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      browserTransport: 'none',
    }).apply(compiler);

    const dependencyCompilation = createCompilation();
    hooks.thisCompilation.call(dependencyCompilation.compilation);
    const dependencyTemplateModule: WebpackModuleLike = {
      resource: `${dependencyPath}?vue&type=template&id=abc`,
      buildInfo: { [WSI_BUILD_METADATA_KEY]: { stale: true } },
    };
    dependencyCompilation.compilation.modules = [dependencyTemplateModule];
    dependencyCompilation.finishModules.call([dependencyTemplateModule]);

    expect(dependencyCompilation.compilation.errors).toEqual([]);
    expect(dependencyTemplateModule.buildInfo?.[WSI_BUILD_METADATA_KEY]).toBeUndefined();
    hooks.watchClose.call();
  });

  it('只提交无错误的当前 compilation，失败 rebuild 保留上一代 manifest', () => {
    const { compiler, hooks, ruleUse } = createDevelopmentCompiler();
    const root = mkdtempSync(path.join(tmpdir(), 'wsi-webpack-plugin-manifest-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const resourcePath = path.join(root, 'src', 'App.vue');
    mkdirSync(path.dirname(resourcePath), { recursive: true });
    writeFileSync(resourcePath, '<template><div /></template>', 'utf8');
    if (!compiler.options) {
      throw new Error('测试 compiler options 不存在');
    }
    compiler.options.context = root;
    const plugin = new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      browserTransport: 'none',
    });
    plugin.apply(compiler);
    hooks.afterPlugins.call(compiler);

    const session = getWebpackAdapterSession(compiler);
    expect(session).not.toBeNull();
    expect(ruleUse[0]).toMatchObject({ loader: WebSourceInspectorWebpackPlugin.loaderPath });
    if (!session) {
      throw new Error('测试 session 未创建');
    }

    const first = createCompilation();
    hooks.thisCompilation.call(first.compilation);
    const firstMetadata = createMetadata(session, 'src/App.vue', '<template><div /></template>');
    const firstModule = moduleWithMetadata(
      firstMetadata,
      `${resourcePath}?vue&type=template&id=abc`,
    );
    first.compilation.modules = [firstModule];
    first.finishModules.call([firstModule]);
    hooks.done.call({ compilation: first.compilation, hasErrors: () => false });
    expect(session.manifest.allRecords().map((record) => record.sourceId)).toEqual([
      firstMetadata.records[0]?.sourceId,
    ]);

    const failed = createCompilation();
    hooks.thisCompilation.call(failed.compilation);
    const failedMetadata = createMetadata(session, 'src/App.vue', '<template><button /></template>');
    const failedModule = moduleWithMetadata(
      failedMetadata,
      `${resourcePath}?vue&type=template&id=abc`,
    );
    failed.compilation.modules = [failedModule];
    failed.finishModules.call([failedModule]);
    failed.compilation.errors.push(new Error('downstream vue compile failed'));
    hooks.done.call({ compilation: failed.compilation, hasErrors: () => true });

    expect(session.manifest.allRecords().map((record) => record.sourceId)).toEqual([
      firstMetadata.records[0]?.sourceId,
    ]);

    const missingMetadata = createCompilation();
    hooks.thisCompilation.call(missingMetadata.compilation);
    const cachedTemplateModule: WebpackModuleLike = {
      resource: `${resourcePath}?vue&type=template&id=abc`,
      buildInfo: {},
    };
    missingMetadata.compilation.modules = [cachedTemplateModule];
    missingMetadata.finishModules.call([cachedTemplateModule]);
    expect(missingMetadata.compilation.errors[0]?.message).toMatch(/缺少 WSI build metadata/);
    hooks.done.call({
      compilation: missingMetadata.compilation,
      hasErrors: () => missingMetadata.compilation.errors.length > 0,
    });
    expect(session.manifest.allRecords().map((record) => record.sourceId)).toEqual([
      firstMetadata.records[0]?.sourceId,
    ]);
    hooks.watchClose.call();
    expect(getWebpackAdapterSession(compiler)).toBeNull();
  });

  it('development apply 只从 Vue template 链移除缓存并保留普通 JS 缓存', () => {
    const { compiler } = createDevelopmentCompiler();
    const rule = compiler.options?.module?.rules?.[0];
    if (!rule || !Array.isArray(rule.use)) {
      throw new Error('测试 Vue rule 不存在');
    }
    rule.use.unshift(
      'C:/workspace/node_modules/cache-loader/dist/cjs.js',
      'C:/workspace/node_modules/thread-loader/dist/cjs.js',
    );
    const pitcherRule = {
      loader: 'C:/workspace/node_modules/vue-loader/lib/loaders/pitcher.js',
      options: {
        cacheDirectory: 'C:/workspace/node_modules/.cache/vue-loader',
        cacheIdentifier: 'vue-loader-cache',
      },
    };
    const templateRenderRule = {
      resource: () => true,
      resourceQuery: (query: string) => query.includes('type=template'),
      use: [
        'C:/workspace/node_modules/cache-loader/dist/cjs.js',
        'C:/workspace/node_modules/babel-loader/lib/index.js',
      ],
    };
    const ordinaryJavaScriptRule = {
      test: /\.js$/,
      use: [
        'C:/workspace/node_modules/cache-loader/dist/cjs.js',
        'C:/workspace/node_modules/babel-loader/lib/index.js',
      ],
    };
    compiler.options?.module?.rules?.unshift(pitcherRule, templateRenderRule);
    compiler.options?.module?.rules?.push(ordinaryJavaScriptRule);
    const diagnostics: string[] = [];
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      browserTransport: 'none',
      diagnostics: (message) => diagnostics.push(message),
    }).apply(compiler);

    const finalLoaders = (rule.use as Array<string | { loader?: string }>).map((entry) =>
      typeof entry === 'string' ? entry : entry.loader,
    );
    expect(finalLoaders.some((loader) => loader?.includes('cache-loader'))).toBe(false);
    expect(finalLoaders.some((loader) => loader?.includes('thread-loader'))).toBe(false);
    expect(pitcherRule.options).toEqual({});
    expect(templateRenderRule.use.some((loader) => loader.includes('cache-loader'))).toBe(false);
    expect(ordinaryJavaScriptRule.use.some((loader) => loader.includes('cache-loader'))).toBe(true);
    expect(diagnostics).toEqual([
      'DEVELOPMENT_LOADER_DISABLED:vue-loader-template-cache',
      'DEVELOPMENT_LOADER_DISABLED:cache-loader',
      'DEVELOPMENT_LOADER_DISABLED:thread-loader',
      'DEVELOPMENT_LOADER_DISABLED:cache-loader',
    ]);
  });
});

function createMetadata(
  session: NonNullable<ReturnType<typeof getWebpackAdapterSession>>,
  moduleId: string,
  source: string,
): WsiBuildMetadata {
  const fullDigest = createSourceDigest(source);
  const generation = session.manifest.allocateGeneration(moduleId, fullDigest);
  const range = {
    startLine: 1,
    startColumn: 11,
    endLine: 1,
    endColumn: 18,
    startOffset: 10,
    endOffset: 17,
  };
  const sourceId = session.createSourceId({
    normalizedRelativePath: moduleId,
    moduleGeneration: generation,
    nodeKind: 'element',
    tagName: 'div',
    range,
    localSnippetDigest: createSourceDigest(source.slice(10, 17)),
  });
  const record: SourceRecord = {
    sourceId,
    rootKey: session.rootKey,
    relativePath: moduleId,
    framework: 'vue',
    kind: 'element',
    tagName: 'div',
    range,
    componentName: 'App',
    controlFlow: null,
    parentSourceId: null,
    sourceDigest: fullDigest,
    contextBefore: null,
    contextAfter: null,
    moduleId,
    generation,
    accuracy: 'exact',
  };
  return {
    ...session.loaderIdentity,
    moduleId,
    fullDigest,
    generation,
    records: [record],
  };
}

function moduleWithMetadata(metadata: WsiBuildMetadata, resource?: string): WebpackModuleLike {
  return { resource, buildInfo: { [WSI_BUILD_METADATA_KEY]: metadata } };
}

function writeJson(filename: string, value: unknown): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, JSON.stringify(value), 'utf8');
}

function writeNodePackage(
  workspaceRoot: string,
  name: string,
  manifest: Record<string, unknown>,
  source?: string,
): void {
  const directory = path.join(workspaceRoot, 'node_modules', ...name.split('/'));
  writeJson(path.join(directory, 'package.json'), manifest);
  if (source) {
    writeFileSync(path.join(directory, 'index.js'), source, 'utf8');
  }
}
