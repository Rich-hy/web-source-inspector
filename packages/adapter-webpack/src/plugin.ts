import { ManifestBuildSupersededError } from '@web-source-inspector/compiler-core';
import { createRequire } from 'node:module';
import path from 'node:path';

import { WEBPACK_ADAPTER_NAME } from './constants.js';
import { WebpackAdapterError } from './errors.js';
import { webpackLoaderPath } from './loader-path.js';
import { injectRuntimeEntry } from './webpack-entry.js';
import { injectRawRuntimePlaceholder } from './webpack-entry.js';
import { startRawLoopbackWatchServer } from './raw-watch-server.js';
import { ensureWebpackBridge } from './browser-session.js';
import {
  isInspectableHtmlTemplateQuery,
  parseVueTemplateQuery,
} from './template-query.js';
import {
  createWebpackAdapterSession,
  disposeWebpackAdapterSession,
} from './registry.js';
import { readBuildMetadata } from './build-metadata.js';
import type {
  CompilationBuildState,
  WebpackAdapterSession,
  WebpackCompilationLike,
  WebpackCompilerLike,
  WebpackModuleLike,
  WebpackStatsLike,
  WebSourceInspectorWebpackPluginOptions,
} from './types.js';
import {
  configureLoaderIdentity,
  resolveVueLoaderMajor,
  validateConfiguredVuePipeline,
} from './vue-rule.js';

export class WebSourceInspectorWebpackPlugin {
  static readonly loaderPath: string = webpackLoaderPath;
  static readonly runtimeModuleRequest: string = '@web-source-inspector/runtime';

  readonly #options: Readonly<WebSourceInspectorWebpackPluginOptions>;
  readonly #loaderPath: string;
  readonly #runtimeModuleRequest: string;

  constructor(options: WebSourceInspectorWebpackPluginOptions = {}) {
    // constructor 只保存不可变配置；随机值和 registry 均延迟到 development apply。
    this.#options = Object.freeze({
      ...options,
      allowedOrigins: options.allowedOrigins
        ? Object.freeze([...options.allowedOrigins])
        : undefined,
    });
    this.#loaderPath = (new.target as typeof WebSourceInspectorWebpackPlugin).loaderPath;
    this.#runtimeModuleRequest =
      options.runtimeModuleRequest ??
      (new.target as typeof WebSourceInspectorWebpackPlugin).runtimeModuleRequest;
  }

  apply(compiler: WebpackCompilerLike): void {
    if (Array.isArray(compiler.compilers)) {
      const hasDevelopmentChild = compiler.compilers.some(
        (childCompiler) => childCompiler.options?.mode === 'development',
      );
      if (hasDevelopmentChild) {
        throw new WebpackAdapterError(
          'MULTI_COMPILER_UNSUPPORTED',
          '首版不支持 Webpack MultiCompiler 或配置数组',
        );
      }
      return;
    }
    const finalMode = compiler.options?.mode;
    if (finalMode !== 'development') {
      return;
    }
    const vueLoaderMajor = resolveVueLoaderMajor(compiler, this.#options.vueLoaderMajor);
    const compilerVersion = resolveCompilerVersion(compiler);
    const session = createWebpackAdapterSession(
      compiler,
      this.#options,
      vueLoaderMajor,
      compilerVersion,
      this.#loaderPath,
    );
    try {
      const loaderConfiguration = configureLoaderIdentity(
        compiler,
        this.#loaderPath,
        session.loaderIdentity,
      );
      for (const disabledLoader of loaderConfiguration.disabledLoaders) {
        session.diagnostics?.(`DEVELOPMENT_LOADER_DISABLED:${disabledLoader}`);
      }
      if (session.wdsCredential) {
        injectRuntimeEntry(compiler, this.#loaderPath, {
          sessionId: session.compilerSessionId,
          sessionEpoch: session.sessionEpoch,
          browserToken: session.wdsCredential.browserToken,
          runtimeModuleRequest: this.#runtimeModuleRequest,
          transport: {
            kind: 'wds',
            basePath: session.wdsCredential.basePath,
          },
        });
        session.runtimeInjected = true;
      } else if (session.rawCredential) {
        injectRawRuntimePlaceholder(compiler, this.#loaderPath, {
          sessionId: session.compilerSessionId,
          sessionEpoch: session.sessionEpoch,
          runtimeModuleRequest: this.#runtimeModuleRequest,
        });
      }
      this.#registerHooks(compiler, session);
    } catch (error) {
      disposeWebpackAdapterSession(compiler);
      throw error;
    }
  }

  #registerHooks(compiler: WebpackCompilerLike, session: WebpackAdapterSession): void {
    compiler.hooks?.afterPlugins?.tap(WEBPACK_ADAPTER_NAME, () => {
      try {
        validateConfiguredVuePipeline(compiler, session.loaderIdentity.loaderPath);
      } catch (error) {
        disposeWebpackAdapterSession(compiler);
        throw error;
      }
    });

    if (!compiler.hooks?.thisCompilation || !compiler.hooks.done) {
      throw new WebpackAdapterError(
        'TEMPLATE_PIPELINE_MISMATCH',
        'Webpack compiler 缺少 thisCompilation/done 生命周期 hook',
      );
    }
    compiler.hooks.thisCompilation.tap(WEBPACK_ADAPTER_NAME, (compilation) => {
      beginCompilation(session, compilation);
    });
    compiler.hooks.done.tap(WEBPACK_ADAPTER_NAME, (stats) => {
      finishCompilation(session, stats);
    });
    compiler.hooks.failed?.tap(WEBPACK_ADAPTER_NAME, () => {
      discardCurrentBuild(session);
      disposeWebpackAdapterSession(compiler);
    });
    compiler.hooks.invalid?.tap(WEBPACK_ADAPTER_NAME, () => {
      discardCurrentBuild(session);
    });
    compiler.hooks.watchClose?.tap(WEBPACK_ADAPTER_NAME, () => {
      disposeWebpackAdapterSession(compiler);
    });
    compiler.hooks.shutdown?.tap(WEBPACK_ADAPTER_NAME, () => {
      disposeWebpackAdapterSession(compiler);
    });
    if (session.rawCredential) {
      this.#registerRawWatchHook(compiler, session);
    }
  }

  #registerRawWatchHook(
    compiler: WebpackCompilerLike,
    session: WebpackAdapterSession,
  ): void {
    const watchRun = compiler.hooks?.watchRun;
    if (watchRun?.tapPromise) {
      watchRun.tapPromise(WEBPACK_ADAPTER_NAME, () =>
        startRawWatchSession(
          compiler,
          session,
        ),
      );
      return;
    }
    if (watchRun?.tapAsync) {
      watchRun.tapAsync(WEBPACK_ADAPTER_NAME, (_watchCompiler, done) => {
        void startRawWatchSession(
          compiler,
          session,
        ).then(
          () => done(),
          (error: unknown) => done(toAdapterError(error)),
        );
      });
      return;
    }
    throw new WebpackAdapterError(
      'TEMPLATE_PIPELINE_MISMATCH',
      'raw Webpack watch 缺少可等待的 watchRun hook，已 fail-closed',
    );
  }
}

async function startRawWatchSession(
  compiler: WebpackCompilerLike,
  session: WebpackAdapterSession,
): Promise<void> {
  if (session.rawStartPromise) {
    return session.rawStartPromise;
  }
  const credential = session.rawCredential;
  const allowedOrigins = credential?.allowedOrigins;
  if (!credential || !allowedOrigins) {
    throw new WebpackAdapterError(
      'INVALID_BROWSER_TRANSPORT_CONFIG',
      'raw Webpack watch 缺少精确 allowedOrigins',
    );
  }
  session.rawStartPromise = (async () => {
    const rawServer = await startRawLoopbackWatchServer({
      allowedOrigins,
      browserMessageHandler: session.browserMessageHandler,
      credential: {
        path: credential.basePath,
        browserToken: credential.browserToken,
      },
    });
    if (session.disposed) {
      await rawServer.dispose();
      return;
    }
    session.rawServer = rawServer;
    try {
      session.runtimeInjected = true;
      ensureWebpackBridge(session);
    } catch (error) {
      session.rawServer = null;
      await rawServer.dispose();
      throw error;
    }
  })();
  try {
    await session.rawStartPromise;
  } catch (error) {
    disposeWebpackAdapterSession(compiler);
    throw error;
  }
}

function beginCompilation(
  session: WebpackAdapterSession,
  compilation: WebpackCompilationLike,
): void {
  const buildId = session.nextBuildId + 1;
  session.nextBuildId = buildId;
  const compilationId = `compilation-${buildId}`;
  const stage = session.manifest.beginBuild({
    compilerId: session.compilerSessionId,
    compilationId,
    buildId,
  });
  const build: CompilationBuildState = {
    buildId,
    compilationId,
    compilation,
    stage,
    moduleIds: new Set(),
    metadataCollected: false,
  };
  session.currentBuild = build;

  const finishModules = compilation.hooks?.finishModules;
  if (finishModules) {
    finishModules.tap(WEBPACK_ADAPTER_NAME, (modules) => {
      collectCompilationMetadata(session, build, modules);
    });
  }
}

function collectCompilationMetadata(
  session: WebpackAdapterSession,
  build: CompilationBuildState,
  modules: Iterable<WebpackModuleLike>,
): void {
  if (build.metadataCollected || build.stage.state !== 'active') {
    return;
  }
  build.metadataCollected = true;
  try {
    for (const webpackModule of modules) {
      // vue-loader pitcher 只生成实际 block request，本身不会执行后续 WSI Loader。
      if (isVueLoaderPitcherModule(webpackModule)) {
        continue;
      }
      const metadata = readBuildMetadata(webpackModule, session);
      if (!metadata) {
        if (isHtmlVueTemplateModule(webpackModule, session)) {
          throw new WebpackAdapterError(
            'TEMPLATE_PIPELINE_MISMATCH',
            'template module 缺少 WSI build metadata；可能命中了未恢复 metadata 的旧缓存',
          );
        }
        continue;
      }
      build.stage.stageModule({
        moduleId: metadata.moduleId,
        generation: metadata.generation,
        fullDigest: metadata.fullDigest,
        records: metadata.records,
      });
      build.moduleIds.add(metadata.moduleId);
    }
    for (const previousModuleId of session.successfulModuleIds) {
      if (!build.moduleIds.has(previousModuleId)) {
        build.stage.removeModule(previousModuleId);
      }
    }
  } catch (error) {
    build.compilation.errors.push(toAdapterError(error));
  }
}

function isVueLoaderPitcherModule(webpackModule: WebpackModuleLike): boolean {
  return webpackModule.loaders?.some((loader) => {
    if (typeof loader.loader !== 'string') {
      return false;
    }
    const normalizedLoader = loader.loader.replace(/\\/g, '/').split('?', 1)[0] ?? '';
    return (
      normalizedLoader.endsWith('/vue-loader/dist/pitcher.js') ||
      normalizedLoader.endsWith('/vue-loader/lib/loaders/pitcher.js')
    );
  }) ?? false;
}

function isHtmlVueTemplateModule(
  webpackModule: WebpackModuleLike,
  session: WebpackAdapterSession,
): boolean {
  const identity = webpackModule.resource ?? webpackModule.identifier?.();
  if (!identity) {
    return false;
  }
  const queryStart = identity.lastIndexOf('?');
  if (queryStart < 0) {
    return false;
  }
  const query = parseVueTemplateQuery(identity.slice(queryStart), session.vueLoaderMajor);
  if (!query) {
    return false;
  }
  return isInspectableHtmlTemplateQuery(query);
}

function finishCompilation(session: WebpackAdapterSession, stats: WebpackStatsLike): void {
  const build = session.currentBuild;
  if (!build) {
    return;
  }
  if (stats.compilation && stats.compilation !== build.compilation) {
    return;
  }
  if (!build.metadataCollected) {
    collectCompilationMetadata(session, build, build.compilation.modules ?? []);
  }
  if (stats.hasErrors() || build.compilation.errors.length > 0) {
    build.stage.discard();
    if (session.currentBuild === build) {
      session.currentBuild = null;
    }
    return;
  }
  if (session.currentBuild !== build || build.stage.state !== 'active') {
    build.stage.discard();
    return;
  }

  try {
    build.stage.commit();
    session.successfulModuleIds = new Set(build.moduleIds);
  } catch (error) {
    build.compilation.errors.push(toAdapterError(error));
    build.stage.discard();
  } finally {
    if (session.currentBuild === build) {
      session.currentBuild = null;
    }
  }
}

function discardCurrentBuild(session: WebpackAdapterSession): void {
  session.currentBuild?.stage.discard();
  session.currentBuild = null;
}

function resolveCompilerVersion(compiler: WebpackCompilerLike): string {
  const directVersion = compiler.webpack?.version ?? compiler.version;
  if (isSupportedWebpackVersion(directVersion)) {
    return directVersion;
  }

  const lookupRoots = new Set([
    compiler.options?.context,
    compiler.context,
    process.cwd(),
  ]);
  for (const lookupRoot of lookupRoots) {
    if (!lookupRoot) {
      continue;
    }
    try {
      const packageRequire = createRequire(
        path.join(path.resolve(lookupRoot), 'package.json'),
      );
      const packagePath = packageRequire.resolve('webpack/package.json');
      const packageValue = packageRequire(packagePath) as unknown;
      const packageVersion = readPackageVersion(packageValue);
      if (isSupportedWebpackVersion(packageVersion)) {
        return packageVersion;
      }
    } catch {
      // 继续尝试 compiler 的其它规范根目录，全部失败后统一阻断。
    }
  }
  throw new WebpackAdapterError(
    'TEMPLATE_PIPELINE_MISMATCH',
    '无法从 Webpack compiler 或项目 webpack/package.json 解析 4.x/5.x 版本',
  );
}

function readPackageVersion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const version = (value as { version?: unknown }).version;
  return typeof version === 'string' ? version : null;
}

function isSupportedWebpackVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(4|5)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  );
}

function toAdapterError(error: unknown): Error {
  if (error instanceof ManifestBuildSupersededError) {
    return new WebpackAdapterError('BUILD_SUPERSEDED', error.message);
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
