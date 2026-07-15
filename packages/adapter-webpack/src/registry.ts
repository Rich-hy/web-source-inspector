import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  SourceManifest,
  createRootKey,
  createSourceIdGenerator,
} from '@web-source-inspector/compiler-core';

import {
  WEBPACK_ADAPTER_VERSION,
  WSI_BUILD_METADATA_SCHEMA_VERSION,
} from './constants.js';
import { normalizeAllowedOrigins } from './browser-security.js';
import {
  createBrowserMessageHandler,
  createWebpackBrowserRouter,
  disposeWebpackBrowserSession,
} from './browser-session.js';
import { WebpackAdapterError } from './errors.js';
import {
  createWebpackSourceBoundary,
  resolveWebpackWorkspaceRoot,
} from './source-boundary.js';
import type {
  BrowserTransportCredential,
  VueLoaderMajor,
  WebpackAdapterSession,
  WebpackCompilerLike,
  WebSourceInspectorWebpackPluginOptions,
  WsiLoaderIdentity,
} from './types.js';

const GLOBAL_REGISTRY_SCHEMA_VERSION = 1;
const GLOBAL_REGISTRY_SYMBOL = Symbol.for('web-source-inspector.adapter-webpack.registry');
const SAFE_ROOT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface GlobalWebpackAdapterRegistry {
  readonly schemaVersion: typeof GLOBAL_REGISTRY_SCHEMA_VERSION;
  readonly adapterVersion: string;
  readonly compilerSessions: WeakMap<WebpackCompilerLike, WebpackAdapterSession>;
}

export function createWebpackAdapterSession(
  compiler: WebpackCompilerLike,
  options: Readonly<WebSourceInspectorWebpackPluginOptions>,
  vueLoaderMajor: VueLoaderMajor,
  compilerVersion: string,
  loaderPath: string,
): WebpackAdapterSession {
  const compilerSessions = getCompilerSessions();
  if (compilerSessions.has(compiler)) {
    throw new WebpackAdapterError(
      'TEMPLATE_PIPELINE_MISMATCH',
      '同一 Webpack compiler 不能重复注册 Source Inspector Plugin',
    );
  }

  const projectRoot = path.resolve(
    options.projectRoot ?? options.root ?? compiler.options?.context ?? compiler.context ?? process.cwd(),
  );
  const workspaceRoot = resolveWebpackWorkspaceRoot(projectRoot, options.workspaceRoot);
  const sourceBoundary = createWebpackSourceBoundary(projectRoot, workspaceRoot);
  const sourceKey = randomBytes(32);
  const compilerSessionId = `webpack_${randomBytes(16).toString('base64url')}`;
  const sessionEpoch = randomBytes(16).toString('base64url');
  const rootKey = options.rootKey ?? createRootKey(
    sourceBoundary.canonicalWorkspaceRoot ?? workspaceRoot,
    sourceKey,
  );
  if (!SAFE_ROOT_KEY_PATTERN.test(rootKey)) {
    throw new TypeError('rootKey 格式无效');
  }

  const loaderIdentity: WsiLoaderIdentity = Object.freeze({
    schemaVersion: WSI_BUILD_METADATA_SCHEMA_VERSION,
    sessionEpoch,
    compilerSessionId,
    adapterVersion: WEBPACK_ADAPTER_VERSION,
    compilerVersion,
    vueLoaderMajor,
    loaderPath,
  });
  const { wdsCredential, rawCredential } = createBrowserCredentials(
    options.allowedOrigins,
    options.browserTransport,
  );
  const browserCredential = wdsCredential ?? rawCredential;
  const manifest = new SourceManifest();
  const browserRouter = browserCredential
    ? createWebpackBrowserRouter(
        compilerSessionId,
        browserCredential,
        manifest,
        options.diagnostics,
      )
    : null;
  const session: WebpackAdapterSession = {
    compiler,
    compilerSessionId,
    sessionEpoch,
    sessionSourceKey: sourceKey,
    compilerVersion,
    vueLoaderMajor,
    projectRoot,
    workspaceRoot,
    sourceBoundary,
    rootKey,
    manifest,
    createSourceId: createSourceIdGenerator(sourceKey),
    loaderIdentity,
    vueVersion: options.vueVersion,
    vueCompiler: options.vueCompiler,
    browserMessageHandler: createBrowserMessageHandler(
      browserRouter,
      options.browserMessageHandler,
      options.diagnostics,
    ),
    browserRouter,
    bridgeEnabled: options.bridge !== false,
    diagnostics: options.diagnostics,
    browserCredential,
    wdsCredential,
    rawCredential,
    nextBuildId: 0,
    currentBuild: null,
    successfulModuleIds: new Set(),
    middleware: null,
    disposeMiddleware: null,
    bridge: null,
    bridgeStartPromise: null,
    browserSweepTimer: null,
    rawServer: null,
    rawStartPromise: null,
    runtimeInjected: false,
    disposed: false,
  };
  compilerSessions.set(compiler, session);
  return session;
}

export function getWebpackAdapterSession(
  compiler: WebpackCompilerLike | undefined,
): WebpackAdapterSession | null {
  return compiler ? getCompilerSessions().get(compiler) ?? null : null;
}

export function disposeWebpackAdapterSession(compiler: WebpackCompilerLike): void {
  const compilerSessions = getCompilerSessions();
  const session = compilerSessions.get(compiler);
  if (!session) {
    return;
  }
  session.disposed = true;
  session.currentBuild?.stage.discard();
  session.currentBuild = null;
  session.disposeMiddleware?.();
  session.disposeMiddleware = null;
  session.middleware = null;
  disposeWebpackBrowserSession(session);
  void session.rawServer?.dispose().catch((error: unknown) => {
    session.diagnostics?.(
      `RAW_SERVER_DISPOSE_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  });
  session.rawServer = null;
  session.manifest.clear();
  session.sessionSourceKey.fill(0);
  session.successfulModuleIds.clear();
  compilerSessions.delete(compiler);
}

/** Plugin 与物理 Loader bundle 通过同一进程级 Symbol registry 共享 compiler session。 */
function getCompilerSessions(): WeakMap<WebpackCompilerLike, WebpackAdapterSession> {
  const globalScope = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalScope[GLOBAL_REGISTRY_SYMBOL];
  if (existing === undefined) {
    const registry: GlobalWebpackAdapterRegistry = Object.freeze({
      schemaVersion: GLOBAL_REGISTRY_SCHEMA_VERSION,
      adapterVersion: WEBPACK_ADAPTER_VERSION,
      compilerSessions: new WeakMap<WebpackCompilerLike, WebpackAdapterSession>(),
    });
    globalScope[GLOBAL_REGISTRY_SYMBOL] = registry;
    return registry.compilerSessions;
  }
  if (!isCompatibleGlobalRegistry(existing)) {
    throw new WebpackAdapterError(
      'TEMPLATE_PIPELINE_MISMATCH',
      'Webpack adapter global registry 版本不兼容，已 fail-closed',
    );
  }
  return existing.compilerSessions;
}

function isCompatibleGlobalRegistry(value: unknown): value is GlobalWebpackAdapterRegistry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<GlobalWebpackAdapterRegistry>;
  return (
    candidate.schemaVersion === GLOBAL_REGISTRY_SCHEMA_VERSION &&
    candidate.adapterVersion === WEBPACK_ADAPTER_VERSION &&
    candidate.compilerSessions instanceof WeakMap
  );
}

function createBrowserCredentials(
  origins: readonly string[] | undefined,
  browserTransport: WebSourceInspectorWebpackPluginOptions['browserTransport'],
): {
  wdsCredential: BrowserTransportCredential | null;
  rawCredential: BrowserTransportCredential | null;
} {
  const transport = browserTransport ?? 'wds';
  if (transport === 'none') {
    return { wdsCredential: null, rawCredential: null };
  }
  if (transport === 'raw' && origins === undefined) {
    throw new WebpackAdapterError(
      'INVALID_BROWSER_TRANSPORT_CONFIG',
      'raw Webpack watch 必须配置精确 allowedOrigins',
    );
  }
  if (transport === 'raw' && origins?.some((origin) => {
    try {
      return new URL(origin).protocol === 'https:';
    } catch {
      return false;
    }
  })) {
    throw new WebpackAdapterError(
      'RAW_WATCH_HTTPS_UNSUPPORTED',
      'raw Webpack watch 不支持 HTTPS allowedOrigins',
    );
  }
  const allowedOrigins = origins === undefined ? null : normalizeAllowedOrigins(origins);
  const credential: BrowserTransportCredential = Object.freeze({
    basePath:
      transport === 'raw'
        ? `/__wsi/raw/${randomBytes(18).toString('base64url')}`
        : `/__wsi/${randomBytes(18).toString('base64url')}`,
    browserToken: randomBytes(32).toString('base64url'),
    allowedOrigins: allowedOrigins ? Object.freeze(allowedOrigins) : null,
    observedOrigins: new Set<string>(),
  });
  return transport === 'raw'
    ? { wdsCredential: null, rawCredential: credential }
    : { wdsCredential: credential, rawCredential: null };
}
