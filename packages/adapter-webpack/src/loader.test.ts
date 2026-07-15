import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

import * as compilerDom from '@vue/compiler-dom';
import * as compilerSfc from '@vue/compiler-sfc';
import {
  createVue3CompilerAdapter,
  type VueCompilerAdapter,
} from '@web-source-inspector/transform-vue';
import { describe, expect, it, onTestFinished } from 'vitest';

import { WSI_BUILD_METADATA_KEY, WSI_LOADER_OPTIONS_KEY } from './constants.js';
import webSourceInspectorWebpackLoader from './loader.js';
import { WebSourceInspectorWebpackPlugin } from './plugin.js';
import type {
  WebpackCompilationLike,
  WebpackCompilerLike,
  WebpackLoaderCallback,
  WebpackLoaderContextLike,
  WebpackModuleLike,
  WebpackStatsLike,
  WsiBuildMetadata,
} from './types.js';

class MockHook<TArguments extends unknown[]> {
  tap(_name: string, _callback: (...arguments_: TArguments) => void): void {}
}

class VueLoaderPlugin {}

describe('webSourceInspectorWebpackLoader', () => {
  it('无 development registry 时原样保留 source/map/additionalData identity', () => {
    const source = Buffer.from('<div />');
    const sourceMap = { version: 3 };
    const additionalData = { owner: 'vue-loader' };
    let callbackArguments: Parameters<WebpackLoaderCallback> | null = null;
    const context: WebpackLoaderContextLike = {
      resourcePath: 'C:/workspace/src/App.vue',
      resourceQuery: '?vue&type=template&id=abc',
      loaderIndex: 0,
      loaders: [],
      async: () => (...arguments_) => {
        callbackArguments = arguments_;
      },
    };

    webSourceInspectorWebpackLoader.call(context, source, sourceMap, additionalData);

    expect(callbackArguments?.[0]).toBeNull();
    expect(callbackArguments?.[1]).toBe(source);
    expect(callbackArguments?.[2]).toBe(sourceMap);
    expect(callbackArguments?.[3]).toBe(additionalData);
  });

  it('workspace link 的完整 SFC 可转换，并只返回带 marker 的 template', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wsi-webpack-loader-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, 'packages', 'linked', 'App.vue');
    const linkedDirectory = path.join(root, 'node_modules', '@workspace', 'linked');
    const resourcePath = path.join(linkedDirectory, 'App.vue');
    const vueLoaderDirectory = path.join(root, 'node_modules', 'vue-loader', 'dist');
    mkdirSync(vueLoaderDirectory, { recursive: true });
    writeFileSync(
      path.join(vueLoaderDirectory, 'descriptorCache.js'),
      [
        "'use strict';",
        'const descriptor = { template: { ast: { type: 0 } } };',
        'module.exports = { getDescriptor() { return descriptor; } };',
      ].join('\n'),
      'utf8',
    );
    const fullSource = [
      '<template><div class="root"><span>你好</span></div></template>',
      '<script setup lang="ts">const value: number = 1</script>',
    ].join('\n');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, fullSource, 'utf8');
    mkdirSync(path.dirname(linkedDirectory), { recursive: true });
    symlinkSync(
      path.dirname(sourcePath),
      linkedDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const templateSource = '<div class="root"><span>你好</span></div>';
    const ruleUse: Array<string | { loader: string; options?: unknown }> = [
      WebSourceInspectorWebpackPlugin.loaderPath,
      path.join(root, 'node_modules', 'vue-loader', 'dist', 'index.js'),
    ];
    const compiler = createCompiler(root, ruleUse, resourcePath, fullSource);
    const vueCompiler = createVue3CompilerAdapter({
      compilerSfc,
      compilerDom,
      version: '3.5.39',
    });
    new WebSourceInspectorWebpackPlugin({
      root,
      vueLoaderMajor: 17,
      vueCompiler,
      browserTransport: 'none',
    }).apply(compiler);

    const loaderEntry = ruleUse[0];
    if (typeof loaderEntry === 'string' || !loaderEntry) {
      throw new Error('Plugin 未注入 Loader identity');
    }
    const webpackModule: WebpackModuleLike = { buildInfo: {} };
    const incomingMap = { source: 'vue-loader-map' };
    const additionalData = { stable: true };
    const result = await invokeLoader({
      resourcePath,
      resourceQuery: '?vue&type=template&id=abc&ts=true',
      rootContext: root,
      loaderIndex: 1,
      loaders: [
        { path: path.join(root, 'node_modules', 'vue-loader', 'dist', 'templateLoader.js') },
        { path: WebSourceInspectorWebpackPlugin.loaderPath },
        { path: path.join(root, 'node_modules', 'vue-loader', 'dist', 'index.js') },
      ],
      _compiler: compiler,
      _module: webpackModule,
      getOptions: () => loaderEntry.options,
    }, templateSource, incomingMap, additionalData);

    expect(result.error).toBeNull();
    expect(result.content).toContain('data-wsi-source=');
    expect(result.content).not.toContain('<template>');
    expect(result.sourceMap).not.toBe(incomingMap);
    expect(result.additionalData).toBe(additionalData);
    const metadata = webpackModule.buildInfo?.[WSI_BUILD_METADATA_KEY] as
      | WsiBuildMetadata
      | undefined;
    expect(metadata?.records.length).toBe(2);
    expect(metadata?.moduleId).toBe('packages/linked/App.vue');
    expect(metadata?.loaderPath).toBe(WebSourceInspectorWebpackPlugin.loaderPath);
    const descriptor = (
      createRequire(import.meta.url)(path.join(vueLoaderDirectory, 'descriptorCache.js')) as {
        getDescriptor(): { template: { ast?: unknown } };
      }
    ).getDescriptor();
    expect(descriptor.template.ast).toBeUndefined();
  });

  it('接受 vue-loader 15 对 Vue 2 原始 template 的 deindent selector 输出', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wsi-webpack-loader-vue2-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const resourcePath = path.join(root, 'src', 'App.vue');
    const fullSource = '<template>\r\n  <div>\r\n    <MyCard />\r\n  </div>\r\n</template>';
    mkdirSync(path.dirname(resourcePath), { recursive: true });
    writeFileSync(resourcePath, fullSource, 'utf8');
    const incomingTemplate = '\n<div>\n  <MyCard />\n</div>\n';
    const vueLoaderPath = path.join(root, 'node_modules', 'vue-loader', 'lib', 'index.js');
    const ruleUse: Array<string | { loader: string; options?: unknown }> = [
      WebSourceInspectorWebpackPlugin.loaderPath,
      vueLoaderPath,
    ];
    const compiler = createCompiler(root, ruleUse, resourcePath, fullSource);
    const vueCompiler: VueCompilerAdapter = {
      family: 'vue2.7',
      version: '2.7.16',
      parseSfc(source) {
        const startOffset = source.indexOf('>') + 1;
        const endOffset = source.lastIndexOf('</template>');
        return {
          template: {
            content: source.slice(startOffset, endOffset),
            startOffset,
            endOffset,
          },
          errors: [],
        };
      },
      parseTemplate(source) {
        const cardStart = source.indexOf('<MyCard');
        return {
          children: [{
            type: 'element',
            tagName: 'div',
            sourceKind: 'element',
            markerKind: 'element',
            controlFlowKind: null,
            reservedAttributeNames: [],
            startOffset: source.indexOf('<div'),
            endOffset: source.lastIndexOf('</div>') + '</div>'.length,
            children: [{
              type: 'element',
              tagName: 'MyCard',
              sourceKind: 'component',
              markerKind: 'component',
              controlFlowKind: null,
              reservedAttributeNames: [],
              startOffset: cardStart,
              endOffset: source.indexOf('/>', cardStart) + 2,
              children: [],
            }],
          }],
          errors: [],
        };
      },
    };
    new WebSourceInspectorWebpackPlugin({
      root,
      vueLoaderMajor: 15,
      vueCompiler,
      browserTransport: 'none',
    }).apply(compiler);

    const loaderEntry = ruleUse[0];
    if (typeof loaderEntry === 'string' || !loaderEntry) {
      throw new Error('Plugin 未注入 Loader identity');
    }
    const result = await invokeLoader({
      resourcePath,
      resourceQuery: '?vue&type=template&id=abc',
      rootContext: root,
      loaderIndex: 1,
      loaders: [
        { path: path.join(root, 'node_modules', 'vue-loader', 'lib', 'loaders', 'templateLoader.js') },
        { path: WebSourceInspectorWebpackPlugin.loaderPath },
        { path: vueLoaderPath },
      ],
      _compiler: compiler,
      _module: { buildInfo: {} },
      getOptions: () => loaderEntry.options,
    }, incomingTemplate, null, null);

    expect(result.error).toBeNull();
    expect(result.content).toContain('<MyCard data-wsi-component-source=');
  });

  it('活动 registry 中非 template query 仍严格旁路', () => {
    const root = path.join(process.cwd(), 'packages', 'adapter-webpack', '.mock-project');
    const resourcePath = path.join(root, 'src', 'App.vue');
    const ruleUse: Array<string | { loader: string; options?: unknown }> = [
      WebSourceInspectorWebpackPlugin.loaderPath,
      path.join(root, 'node_modules', 'vue-loader', 'dist', 'index.js'),
    ];
    const compiler = createCompiler(root, ruleUse, resourcePath, '<template><div /></template>');
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      browserTransport: 'none',
    }).apply(compiler);
    const sourceMap = { same: true };
    const additionalData = { same: true };
    let result: Parameters<WebpackLoaderCallback> | null = null;
    webSourceInspectorWebpackLoader.call(
      {
        resourcePath,
        resourceQuery: '?vue&type=script&lang=ts',
        loaderIndex: 0,
        loaders: [],
        _compiler: compiler,
        async: () => (...arguments_) => {
          result = arguments_;
        },
      },
      'const value = 1',
      sourceMap,
      additionalData,
    );
    expect(result?.[1]).toBe('const value = 1');
    expect(result?.[2]).toBe(sourceMap);
    expect(result?.[3]).toBe(additionalData);
  });

  it('第三方 Vue template 在读取 identity、文件系统或 compiler 前清理 metadata 并保留回调 identity', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wsi-webpack-loader-dependency-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const resourcePath = path.join(root, 'node_modules', 'dependency', 'Dependency.vue');
    const fullSource = '<template><div /></template>';
    mkdirSync(path.dirname(resourcePath), { recursive: true });
    writeFileSync(resourcePath, fullSource, 'utf8');
    const ruleUse: Array<string | { loader: string; options?: unknown }> = [
      WebSourceInspectorWebpackPlugin.loaderPath,
      path.join(root, 'node_modules', 'vue-loader', 'dist', 'index.js'),
    ];
    const compiler = createCompiler(root, ruleUse, resourcePath, fullSource);
    new WebSourceInspectorWebpackPlugin({
      root,
      vueLoaderMajor: 17,
      browserTransport: 'none',
    }).apply(compiler);
    compiler.inputFileSystem = {
      readFile() {
        throw new Error('不应读取第三方完整 SFC');
      },
    };

    const source = Buffer.from('<div />');
    const sourceMap = { source: 'vue-loader-map' };
    const additionalData = { owner: 'vue-loader' };
    const webpackModule: WebpackModuleLike = {
      buildInfo: { [WSI_BUILD_METADATA_KEY]: { stale: true } },
    };
    let callbackCount = 0;
    let callbackArguments: Parameters<WebpackLoaderCallback> | null = null;
    webSourceInspectorWebpackLoader.call(
      {
        resourcePath,
        resourceQuery: '?vue&type=template&id=abc',
        loaderIndex: 0,
        loaders: [],
        _compiler: compiler,
        _module: webpackModule,
        getOptions() {
          throw new Error('不应读取 WSI Loader identity');
        },
        async: () => (...arguments_) => {
          callbackCount += 1;
          callbackArguments = arguments_;
        },
      },
      source,
      sourceMap,
      additionalData,
    );

    expect(callbackCount).toBe(1);
    expect(callbackArguments?.[0]).toBeNull();
    expect(callbackArguments?.[1]).toBe(source);
    expect(callbackArguments?.[2]).toBe(sourceMap);
    expect(callbackArguments?.[3]).toBe(additionalData);
    expect(webpackModule.buildInfo?.[WSI_BUILD_METADATA_KEY]).toBeUndefined();
  });

  it('Pug 与 external src template 在读取 identity、文件系统或 compiler 前严格旁路', () => {
    const root = path.join(process.cwd(), 'packages', 'adapter-webpack', '.mock-project');
    const resourcePath = path.join(root, 'src', 'App.vue');
    const ruleUse: Array<string | { loader: string; options?: unknown }> = [
      WebSourceInspectorWebpackPlugin.loaderPath,
      path.join(root, 'node_modules', 'vue-loader', 'dist', 'index.js'),
    ];
    const compiler = createCompiler(root, ruleUse, resourcePath, '<template><div /></template>');
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      browserTransport: 'none',
    }).apply(compiler);
    compiler.inputFileSystem = {
      readFile() {
        throw new Error('不应读取完整 SFC');
      },
    };

    for (const resourceQuery of [
      '?vue&type=template&id=abc&lang=pug',
      '?vue&type=template&id=abc&src=true',
      '?vue&type=template&id=abc&src',
    ]) {
      const source = '<div />';
      const sourceMap = { query: resourceQuery };
      const additionalData = { query: resourceQuery };
      const webpackModule: WebpackModuleLike = {
        buildInfo: { [WSI_BUILD_METADATA_KEY]: { stale: true } },
      };
      let result: Parameters<WebpackLoaderCallback> | null = null;

      webSourceInspectorWebpackLoader.call(
        {
          resourcePath,
          resourceQuery,
          loaderIndex: 0,
          loaders: [],
          _compiler: compiler,
          _module: webpackModule,
          getOptions() {
            throw new Error('不应读取 WSI Loader identity');
          },
          async: () => (...arguments_) => {
            result = arguments_;
          },
        },
        source,
        sourceMap,
        additionalData,
      );

      expect(result?.[0]).toBeNull();
      expect(result?.[1]).toBe(source);
      expect(result?.[2]).toBe(sourceMap);
      expect(result?.[3]).toBe(additionalData);
      expect(webpackModule.buildInfo?.[WSI_BUILD_METADATA_KEY]).toBeUndefined();
    }
  });
});

function createCompiler(
  root: string,
  ruleUse: Array<string | { loader: string; options?: unknown }>,
  resourcePath: string,
  fullSource: string,
): WebpackCompilerLike {
  return {
    options: {
      mode: 'development',
      context: root,
      module: { rules: [{ use: ruleUse }] },
      plugins: [new VueLoaderPlugin()],
    },
    webpack: { version: '5.99.0' },
    inputFileSystem: {
      readFile(filename, callback) {
        callback(
          filename === resourcePath ? null : Object.assign(new Error('not found'), { code: 'ENOENT' }),
          filename === resourcePath ? Buffer.from(fullSource) : undefined,
        );
      },
    },
    hooks: {
      afterPlugins: new MockHook<[WebpackCompilerLike]>(),
      thisCompilation: new MockHook<[WebpackCompilationLike]>(),
      done: new MockHook<[WebpackStatsLike]>(),
    },
  };
}

function invokeLoader(
  context: Omit<WebpackLoaderContextLike, 'async'>,
  source: string,
  sourceMap: unknown,
  additionalData: unknown,
): Promise<{
  error: Error | null;
  content: string;
  sourceMap: unknown;
  additionalData: unknown;
}> {
  return new Promise((resolve) => {
    webSourceInspectorWebpackLoader.call(
      {
        ...context,
        async: () => (error, content, outputMap, outputAdditionalData) => {
          resolve({
            error,
            content: typeof content === 'string' ? content : content?.toString('utf8') ?? '',
            sourceMap: outputMap,
            additionalData: outputAdditionalData,
          });
        },
      },
      source,
      sourceMap,
      additionalData,
    );
  });
}
