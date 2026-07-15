import {
  ManifestBuildSupersededError,
  canResolveProjectPackageSpecifier,
  classifyVueFamily,
  evaluateRawWebpackOrigin,
  evaluateToolchainCompatibility,
  findProjectPackageFact,
} from '@web-source-inspector/compiler-core';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveVueCompilerAdapter } from '@web-source-inspector/transform-vue';

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
import { clearBuildMetadata, readBuildMetadata } from './build-metadata.js';
import {
  classifyWebpackSource,
  resolveWebpackWorkspaceRoot,
  type CanonicalSourceClassification,
} from './source-boundary.js';
import type {
  CompilationBuildState,
  WebpackAdapterSession,
  WebpackCompilationLike,
  WebpackCompilerLike,
  WebpackModuleLike,
  WebpackStatsLike,
  WebSourceInspectorWebpackPluginOptions,
  WsiBuildMetadata,
} from './types.js';
import {
  configureLoaderIdentity,
  resolveVueLoaderMajor,
  validateConfiguredVuePipeline,
} from './vue-rule.js';

function projectRootForCompiler(
  compiler: WebpackCompilerLike,
  options: Readonly<WebSourceInspectorWebpackPluginOptions>,
): string {
  return path.resolve(
    options.projectRoot
      ?? options.root
      ?? compiler.options?.context
      ?? compiler.context
      ?? process.cwd(),
  );
}

function declaresWebpackVueToolchain(projectRoot: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const manifest = value as Record<string, unknown>;
    const names = ['dependencies', 'devDependencies'].flatMap((field) => {
      const dependencies = manifest[field];
      return typeof dependencies === 'object' && dependencies !== null && !Array.isArray(dependencies)
        ? Object.keys(dependencies)
        : [];
    });
    return names.includes('vue')
      && (names.includes('webpack')
        || names.includes('vue-loader')
        || names.includes('@vue/cli-service'));
  } catch {
    return false;
  }
}

/**
 * 真实项目根存在时只相信实际 package facts；无磁盘根的受控测试仍由原有 pipeline 校验覆盖。
 */
function preflightWebpackToolchain(
  compiler: WebpackCompilerLike,
  options: Readonly<WebSourceInspectorWebpackPluginOptions>,
): void {
  const projectRoot = projectRootForCompiler(compiler, options);
  if (!existsSync(path.join(projectRoot, 'package.json'))
    || !declaresWebpackVueToolchain(projectRoot)) {
    return;
  }
  const workspaceRoot = resolveWebpackWorkspaceRoot(projectRoot, options.workspaceRoot);
  const projectAnchor = createProjectPackageAnchor(workspaceRoot, projectRoot);
  const findFact = (packageName: string) => projectAnchor
    ? findProjectPackageFact(workspaceRoot, packageName, { anchor: projectAnchor })
    : undefined;
  const vue = findFact('vue');
  const webpack = findFact('webpack');
  const vueLoader = findFact('vue-loader');
  const webpackDevServer = findFact('webpack-dev-server');
  const vueTemplateCompiler = findFact('vue-template-compiler');
  const vueCompilerSfc = findFact('@vue/compiler-sfc');
  const vueCompilerDom = findFact('@vue/compiler-dom');
  const vueFamily = classifyVueFamily(vue?.version);
  const vueCompilerSfcFromVueAnchor = vueFamily.status === 'supported'
    && vueFamily.family === 'vue2.7'
    && canResolveProjectPackageSpecifier(workspaceRoot, 'vue/compiler-sfc', {
      anchor: vue ? { packageJsonPath: vue.packageJsonPath } : undefined,
    });
  const transport = options.browserTransport ?? 'wds';
  const issues = evaluateToolchainCompatibility({
    node: {
      nodeVersion: process.versions.node,
      toolchainEngineRange: webpack?.engines.node,
      toolchainName: webpack?.name,
    },
    packageManager: 'unknown',
    vue,
    bundler: 'webpack',
    webpack,
    vueLoader,
    vueTemplateCompiler,
    vueCompilerSfc,
    vueCompilerDom,
    vueCompilerSfcFromVueAnchor,
    webpackTransport: transport === 'wds'
      ? 'webpack-dev-server'
      : transport === 'raw'
        ? 'raw-watch'
        : 'none',
    webpackDevServer,
    rawWebpackOrigin: transport === 'raw' ? options.allowedOrigins?.[0] : undefined,
  });
  if (transport === 'raw' && options.allowedOrigins) {
    for (const origin of options.allowedOrigins.slice(1)) {
      issues.push(...evaluateRawWebpackOrigin(origin));
    }
  }
  const blocking = issues.filter((issue) => issue.severity === 'error');
  for (const issue of issues) {
    options.diagnostics?.(issue.code);
  }
  if (blocking.length > 0) {
    throw new WebpackAdapterError(
      blocking.some((issue) => issue.code === 'RAW_WATCH_HTTPS_UNSUPPORTED')
        ? 'RAW_WATCH_HTTPS_UNSUPPORTED'
        : 'TOOLCHAIN_UNSUPPORTED',
      'Webpack 工具链不满足 Source Inspector 兼容合同。',
    );
  }
  let actualCompiler;
  try {
    actualCompiler = resolveVueCompilerAdapter({
      projectRoot,
      vueVersion: options.vueVersion,
    });
  } catch {
    throw new WebpackAdapterError(
      'TOOLCHAIN_UNSUPPORTED',
      '无法证明实际 Vue compiler 与 Vue 版本一致。',
    );
  }
  if (options.vueCompiler
    && (options.vueCompiler.family !== actualCompiler.family
      || options.vueCompiler.version !== actualCompiler.version)) {
    throw new WebpackAdapterError(
      'TOOLCHAIN_UNSUPPORTED',
      '显式 Vue compiler 与实际项目 Vue 版本不一致。',
    );
  }
}

/** 只允许已确认 workspace 内的项目 package.json 作为 package facts 的查找锚点。 */
function createProjectPackageAnchor(
  workspaceRoot: string,
  projectRoot: string,
): { packageJsonPath: string } | undefined {
  try {
    const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
    const canonicalProjectRoot = realpathSync.native(projectRoot);
    const projectManifest = path.join(canonicalProjectRoot, 'package.json');
    const relativePath = path.relative(canonicalWorkspaceRoot, projectManifest);
    if (
      !relativePath
      || path.isAbsolute(relativePath)
      || path.basename(relativePath) !== 'package.json'
      || relativePath.split(/[\\/]/u).some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      return undefined;
    }
    return { packageJsonPath: relativePath.split(path.sep).join('/') };
  } catch {
    return undefined;
  }
}

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
    preflightWebpackToolchain(compiler, this.#options);
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
      const templateResource = getInspectableTemplateResource(webpackModule, session);
      if (!templateResource) {
        clearBuildMetadata(webpackModule);
        continue;
      }
      const sourceClassification = classifyWebpackSource(
        session.sourceBoundary,
        templateResource,
      );
      if (sourceClassification.kind !== 'inspectable') {
        clearBuildMetadata(webpackModule);
        continue;
      }
      const metadata = readBuildMetadata(webpackModule, session);
      if (!metadata) {
        throw new WebpackAdapterError(
          'TEMPLATE_PIPELINE_MISMATCH',
          'template module 缺少 WSI build metadata；可能命中了未恢复 metadata 的旧缓存',
        );
      }
      assertMetadataSourceBoundary(metadata, sourceClassification);
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

function getInspectableTemplateResource(
  webpackModule: WebpackModuleLike,
  session: WebpackAdapterSession,
): string | null {
  const resource = webpackModule.resource;
  if (!resource) {
    return null;
  }
  const queryStart = resource.lastIndexOf('?');
  if (queryStart < 0) {
    return null;
  }
  const query = parseVueTemplateQuery(resource.slice(queryStart), session.vueLoaderMajor);
  if (!query) {
    return null;
  }
  return isInspectableHtmlTemplateQuery(query) ? resource.slice(0, queryStart) : null;
}

function assertMetadataSourceBoundary(
  metadata: WsiBuildMetadata,
  sourceClassification: Extract<CanonicalSourceClassification, { kind: 'inspectable' }>,
): void {
  if (
    metadata.moduleId !== sourceClassification.relativePath
    || metadata.records.some((record) => record.relativePath !== sourceClassification.relativePath)
  ) {
    throw new WebpackAdapterError(
      'TEMPLATE_PIPELINE_MISMATCH',
      'template module WSI metadata 与 canonical source boundary 不一致',
    );
  }
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
