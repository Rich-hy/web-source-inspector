import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  createSourceDigest,
  createRootKey as createCompilerRootKey,
  createSourceIdGenerator,
  SourceManifest,
  type CandidatePreference,
  type ResolvedSourceCandidate,
  type SourceManifestStage,
  type SourceRecord
} from '@web-source-inspector/compiler-core';
import {
  createBridgePath,
  createBridgeToken,
  createBrowserAddressPolicy,
  createBrowserAddressSnapshot,
  createBrowserToken,
  createLoopbackBridge,
  createSessionHmacKey,
  createSessionId,
  getSessionDirectory,
  type BrowserAddressPolicy,
  type BrowserAddressSnapshot,
  type SessionRoot,
} from '@web-source-inspector/dev-session-core';
import {
  PROTOCOL_VERSION,
  SESSION_SCHEMA_VERSION
} from '@web-source-inspector/protocol';
import {
  resolveVueCompilerAdapter,
  transformVueSfc,
  type VueCompilerAdapter,
} from '@web-source-inspector/transform-vue';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import { resolveViteBrowserAccessContext } from './browser-access';
import { BrowserRouter, browserEvents, type ViteBrowserClient } from './browser-router';
import {
  createClientModule,
  createRuntimeModule,
  RESOLVED_VIRTUAL_CLIENT_ID,
  RESOLVED_VIRTUAL_RUNTIME_ID,
  VIRTUAL_CLIENT_ID,
  VIRTUAL_RUNTIME_ID
} from './client-module';
import {
  resolveInspectorAssets,
  resolveInspectorOptions,
  type WebSourceInspectorAssets,
  type WebSourceInspectorOptions,
} from './types';
import { findWorkspaceRoot, resolveVueSfcRequest, shouldTransform, toWireRelativePath } from './workspace';

export type {
  BrowserAccessMode,
  WebSourceInspectorAssets,
  WebSourceInspectorOptions,
} from './types';
export { COMPONENT_SOURCE_ATTRIBUTE, SOURCE_ATTRIBUTE } from '@web-source-inspector/runtime';

interface PendingModuleState {
  stage: SourceManifestStage;
}

interface ActiveViteSession {
  sessionId: string;
  sessionSourceKey: Buffer;
  browserToken: string;
  manifest: SourceManifest;
  createSourceId: ReturnType<typeof createSourceIdGenerator>;
  compiler: VueCompilerAdapter;
  pendingModules: Map<string, PendingModuleState>;
  moduleBuildIds: Map<string, number>;
  rootKey: string;
  browserAddressSnapshot: BrowserAddressSnapshot;
  browserAddressPolicy: BrowserAddressPolicy;
  allowedOrigins: readonly string[];
  browserAccessInitialized: boolean;
  browserRouter: BrowserRouter;
  bridgeDispose?: () => Promise<void>;
  bridgeStartPromise?: Promise<void>;
  serverClosing: boolean;
}

function resolveSourceRoots(workspaceRoot: string, sourceRoots: string[]): string[] {
  return sourceRoots.map((root) => realpathSync(path.resolve(workspaceRoot, root)));
}

function preferredCandidate(modifiers: { shift: boolean; alt: boolean }): CandidatePreference {
  if (modifiers.alt) {
    return 'control-flow';
  }
  if (modifiers.shift) {
    return 'component';
  }
  return 'default';
}

function createRuntimeHtmlTag(base: string): {
  tag: 'script';
  attrs: Record<string, string>;
  injectTo: 'head-prepend';
} {
  const devBase = base === './' || base === '' ? '/' : base;
  return {
    tag: 'script',
    attrs: {
      type: 'module',
      src: `${devBase}@id/${VIRTUAL_CLIENT_ID}`
    },
    injectTo: 'head-prepend'
  };
}

function moduleCompilerId(sessionId: string, moduleId: string): string {
  const moduleDigest = createHash('sha256').update(moduleId).digest('base64url').slice(0, 22);
  return `vite_${sessionId}_${moduleDigest}`;
}

/**
 * 在 Vite 开发态建立编译映射、浏览器选择器和本机 IDE Bridge。
 */
export function webSourceInspector(
  userOptions: WebSourceInspectorOptions = {},
  adapterAssets: WebSourceInspectorAssets = {},
): Plugin[] {
  const options = resolveInspectorOptions(userOptions);
  const assets = resolveInspectorAssets(adapterAssets);
  let resolvedConfig: ResolvedConfig | undefined;
  let devServeEligible = false;
  let workspaceRoot = '';
  let sourceRoots: string[] = [];
  let activeSession: ActiveViteSession | undefined;

  function debug(message: string): void {
    if (options.debugLog) {
      resolvedConfig?.logger.info(`[wsi] ${message}`);
    }
  }

  function resolveRecord(
    sourceId: string,
    modifiers: { shift: boolean; alt: boolean }
  ): { status: 'found'; record: SourceRecord; candidates: ResolvedSourceCandidate[] }
    | { status: 'stale' | 'not-found' } {
    const session = activeSession;
    if (!session) {
      return { status: 'not-found' };
    }
    const resolved = session.manifest.resolveCandidates(sourceId, preferredCandidate(modifiers));
    if (resolved.status !== 'found') {
      return { status: resolved.status };
    }
    return {
      status: 'found',
      record: resolved.resolution.primary.record,
      candidates: resolved.resolution.candidates
    };
  }

  async function startBridge(
    sessionRoot: SessionRoot,
    session: ActiveViteSession,
  ): Promise<void> {
    if (!options.bridge || session.bridgeDispose) {
      return;
    }
    const bridge = await createLoopbackBridge({
      session: {
        schemaVersion: SESSION_SCHEMA_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        sessionId: session.sessionId,
        pid: process.pid,
        bridgePath: createBridgePath(),
        token: createBridgeToken(),
        createdAt: Date.now(),
        projectName: path.basename(workspaceRoot),
        canonicalRoots: [sessionRoot],
        // 协议字段尚未声明 readonly；运行时仍复用同一个冻结 Origin 数组。
        devOrigins: session.allowedOrigins as string[],
        capabilities: ['vue', 'metadata', 'candidate', 'remote-toggle', 'context-anchor']
      },
      sessionDirectory: getSessionDirectory(),
      getBrowserTabs: () => session.browserRouter.getTabs(),
      onOpenResult: (result) => session.browserRouter.sendResult(result),
      onConnectionChange: (state) => session.browserRouter.updateConnection(state),
      onSetBrowserMode: (request) => session.browserRouter.setBrowserMode(request),
      onDiagnostics: debug
    });
    if (session.serverClosing || activeSession !== session) {
      await bridge.dispose();
      return;
    }
    session.browserRouter.setBridge(bridge);
    session.bridgeDispose = () => bridge.dispose();
    debug('BRIDGE_READY');
  }

  const prePlugin: Plugin = {
    name: 'web-source-inspector',
    apply: 'serve',
    enforce: 'pre',

    configResolved(config) {
      resolvedConfig = config;
      devServeEligible =
        options.enabled &&
        config.command === 'serve' &&
        (config as ResolvedConfig & { isPreview?: boolean }).isPreview !== true;
    },

    resolveId(id) {
      if (!activeSession || !options.ui.enabled) {
        return null;
      }
      if (id === VIRTUAL_CLIENT_ID) {
        return RESOLVED_VIRTUAL_CLIENT_ID;
      }
      if (id === VIRTUAL_RUNTIME_ID) {
        return RESOLVED_VIRTUAL_RUNTIME_ID;
      }
      return null;
    },

    load(id) {
      const session = activeSession;
      if (session && options.ui.enabled && id === RESOLVED_VIRTUAL_CLIENT_ID) {
        return createClientModule(session.sessionId, session.browserToken, options.ui);
      }
      if (session && options.ui.enabled && id === RESOLVED_VIRTUAL_RUNTIME_ID) {
        return createRuntimeModule(assets);
      }
      return null;
    },

    transformIndexHtml() {
      return activeSession && options.ui.enabled && resolvedConfig
        ? [createRuntimeHtmlTag(resolvedConfig.base)]
        : [];
    },

    transform(source, moduleId) {
      const session = activeSession;
      if (!session) {
        return null;
      }
      const filename = resolveVueSfcRequest(moduleId);
      if (!filename || !shouldTransform(filename, workspaceRoot, sourceRoots, options.include, options.exclude)) {
        return null;
      }
      const relativePath = toWireRelativePath(workspaceRoot, filename);
      if (!relativePath) {
        debug('PATH_OUTSIDE_WORKSPACE');
        return null;
      }

      const digest = createSourceDigest(source);
      const generation = session.manifest.allocateGeneration(filename, digest);
      const previousPending = session.pendingModules.get(filename);
      previousPending?.stage.discard();
      session.pendingModules.delete(filename);
      const result = transformVueSfc({
        source,
        filename,
        rootKey: session.rootKey,
        relativePath,
        moduleId: filename,
        moduleGeneration: generation,
        compiler: session.compiler,
        createSourceId: session.createSourceId,
        sourceMap: true,
      });
      const hasError = result.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
      if (!hasError) {
        const buildId = (session.moduleBuildIds.get(filename) ?? 0) + 1;
        session.moduleBuildIds.set(filename, buildId);
        const stage = session.manifest.beginBuild({
          compilerId: moduleCompilerId(session.sessionId, filename),
          compilationId: `vite_${buildId}_${generation}`,
          buildId,
        });
        try {
          stage.stageModule({
            moduleId: filename,
            generation,
            fullDigest: digest,
            records: result.records,
          });
        } catch (error) {
          stage.discard();
          throw error;
        }
        session.pendingModules.set(filename, {
          stage,
        });
      }

      for (const diagnostic of result.diagnostics) {
        if (diagnostic.severity !== 'info') {
          resolvedConfig?.logger.warn(`[wsi] ${diagnostic.code}: ${relativePath}`);
        }
      }
      if (!result.transformed) {
        return null;
      }
      return {
        code: result.code,
        map: result.map || undefined
      };
    },

    async configureServer(server) {
      const config = resolvedConfig;
      if (!devServeEligible || !config) {
        return;
      }
      if (activeSession) {
        throw new Error('VITE_SESSION_ALREADY_ACTIVE');
      }
      workspaceRoot = findWorkspaceRoot(config.root, options.workspaceRoot);
      sourceRoots = resolveSourceRoots(workspaceRoot, options.sourceRoots);
      const compiler = options.compiler ?? resolveVueCompilerAdapter({
        projectRoot: realpathSync(config.root),
      });
      const sessionSourceKey = createSessionHmacKey();
      const sessionId = createSessionId();
      const manifest = new SourceManifest({
        tombstoneTtlMs: 5 * 60_000,
        tombstoneCapacity: 20_000,
        recordCapacity: 200_000,
        onDiagnostic: (diagnostic) => debug(diagnostic.code),
      });
      const rootKey = createCompilerRootKey(workspaceRoot, sessionSourceKey);
      const browserToken = createBrowserToken();
      const browserAddressSnapshot = createBrowserAddressSnapshot();
      const browserAddressPolicy = createBrowserAddressPolicy({
        mode: options.browserAccess,
        snapshot: browserAddressSnapshot,
      });
      let session!: ActiveViteSession;
      const browserRouter = new BrowserRouter({
        sessionId,
        browserToken,
        browserAddressPolicy,
        allowedOrigins: () => session.allowedOrigins,
        resolveSource: resolveRecord,
        diagnostics: debug
      });
      session = {
        sessionId,
        sessionSourceKey,
        browserToken,
        manifest,
        createSourceId: createSourceIdGenerator(sessionSourceKey),
        compiler,
        pendingModules: new Map(),
        moduleBuildIds: new Map(),
        rootKey,
        browserAddressSnapshot,
        browserAddressPolicy,
        allowedOrigins: Object.freeze([]),
        browserAccessInitialized: false,
        browserRouter,
        serverClosing: false,
      };
      activeSession = session;
      const sessionRoot: SessionRoot = {
        rootKey,
        canonicalPath: workspaceRoot,
        displayName: path.basename(workspaceRoot)
      };

      const handleHello = (payload: unknown, client: unknown): void => {
        session.browserRouter.handleHello(payload, client as unknown as ViteBrowserClient);
      };
      const handleHeartbeat = (payload: unknown, client: unknown): void => {
        session.browserRouter.handleHeartbeat(payload, client as unknown as ViteBrowserClient);
      };
      const handleMetadataRequest = (payload: unknown, client: unknown): void => {
        session.browserRouter.handleMetadataRequest(payload, client as unknown as ViteBrowserClient);
      };
      const handleSelection = (payload: unknown, client: unknown): void => {
        session.browserRouter.handleSelection(payload, client as unknown as ViteBrowserClient);
      };
      const handleDispose = (payload: unknown, client: unknown): void => {
        session.browserRouter.handleDispose(payload, client as unknown as ViteBrowserClient);
      };
      server.ws.on(browserEvents.hello, handleHello);
      server.ws.on(browserEvents.heartbeat, handleHeartbeat);
      server.ws.on(browserEvents.metadataRequest, handleMetadataRequest);
      server.ws.on(browserEvents.select, handleSelection);
      server.ws.on(browserEvents.dispose, handleDispose);

      const handleUnlink = (filename: string): void => {
        const canonical = path.resolve(filename);
        const pending = session.pendingModules.get(canonical);
        pending?.stage.discard();
        session.pendingModules.delete(canonical);
        const buildId = (session.moduleBuildIds.get(canonical) ?? 0) + 1;
        session.moduleBuildIds.set(canonical, buildId);
        const stage = session.manifest.beginBuild({
          compilerId: moduleCompilerId(session.sessionId, canonical),
          compilationId: `vite_remove_${buildId}`,
          buildId,
        });
        try {
          stage.removeModule(canonical);
          stage.commit();
        } catch (error) {
          stage.discard();
          config.logger.error(`[wsi] MODULE_REMOVE_FAILED: ${error instanceof Error ? error.message : 'unknown'}`);
        }
      };
      server.watcher.on('unlink', handleUnlink);
      const browserSweepTimer = setInterval(() => session.browserRouter.sweepStalePages(), 30_000);
      browserSweepTimer.unref?.();

      const initializeBrowserAccess = (): boolean => {
        if (session.serverClosing) {
          return false;
        }
        if (session.browserAccessInitialized) {
          return true;
        }
        try {
          const context = resolveViteBrowserAccessContext({
            browserAccess: options.browserAccess,
            server,
            config,
            browserAddressSnapshot: session.browserAddressSnapshot,
            browserAddressPolicy: session.browserAddressPolicy,
            diagnostics: debug,
          });
          session.browserAddressPolicy = context.browserAddressPolicy;
          session.allowedOrigins = context.allowedOrigins;
          session.browserAccessInitialized = true;
          return context.actualPort !== null || options.browserAccess === 'loopback';
        } catch (error) {
          const message = error instanceof Error ? error.message : 'BROWSER_ACCESS_INIT_FAILED';
          config.logger.error(`[wsi] ${message}`);
          return false;
        }
      };
      const start = (): void => {
        if (!initializeBrowserAccess()) {
          return;
        }
        session.bridgeStartPromise ||= startBridge(sessionRoot, session).catch((error: unknown) => {
          config.logger.error(`[wsi] BRIDGE_START_FAILED: ${error instanceof Error ? error.message : 'unknown'}`);
        });
      };
      if (server.httpServer?.listening) {
        start();
      } else if (!server.httpServer) {
        start();
      } else {
        server.httpServer?.once('listening', start);
      }
      let disposeStarted = false;
      const disposeSession = (): void => {
        if (disposeStarted) {
          return;
        }
        disposeStarted = true;
        session.serverClosing = true;
        clearInterval(browserSweepTimer);
        server.ws.off?.(browserEvents.hello, handleHello);
        server.ws.off?.(browserEvents.heartbeat, handleHeartbeat);
        server.ws.off?.(browserEvents.metadataRequest, handleMetadataRequest);
        server.ws.off?.(browserEvents.select, handleSelection);
        server.ws.off?.(browserEvents.dispose, handleDispose);
        server.watcher.off('unlink', handleUnlink);
        server.watcher.off('close', disposeSession);
        server.httpServer?.off('listening', start);
        server.httpServer?.off('close', disposeSession);
        for (const pending of session.pendingModules.values()) {
          pending.stage.discard();
        }
        session.browserRouter.dispose();
        void (async () => {
          await session.bridgeStartPromise;
          await session.bridgeDispose?.();
          session.bridgeDispose = undefined;
        })();
        session.manifest.clear();
        session.pendingModules.clear();
        session.moduleBuildIds.clear();
        session.allowedOrigins = Object.freeze([]);
        session.browserAccessInitialized = false;
        session.sessionSourceKey.fill(0);
        session.browserToken = '';
        if (activeSession === session) {
          activeSession = undefined;
        }
      };
      server.httpServer?.once('close', disposeSession);
      server.watcher.once('close', disposeSession);
    }
  };

  const commitPlugin: Plugin = {
    name: 'web-source-inspector:commit',
    apply: 'serve',
    enforce: 'post',
    transform(_code, moduleId) {
      const session = activeSession;
      if (!session) {
        return null;
      }
      const filename = resolveVueSfcRequest(moduleId);
      if (!filename) {
        return null;
      }
      const pending = session.pendingModules.get(filename);
      if (!pending) {
        return null;
      }
      session.pendingModules.delete(filename);
      try {
        pending.stage.commit();
      } catch (error) {
        pending.stage.discard();
        throw error;
      }
      return null;
    },
  };

  return [prePlugin, commitPlugin];
}

export default webSourceInspector;
