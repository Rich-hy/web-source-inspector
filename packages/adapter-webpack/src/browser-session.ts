import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { CandidatePreference } from '@web-source-inspector/compiler-core';
import {
  BrowserRouter,
  browserEvents,
  createBrowserAddressPolicy,
  createBridgePath,
  createBridgeToken,
  createLoopbackBridge,
  getSessionDirectory,
  type BrowserTransportClient,
} from '@web-source-inspector/dev-session-core';
import { PROTOCOL_VERSION, SESSION_SCHEMA_VERSION } from '@web-source-inspector/protocol';

import type {
  BrowserTransportCredential,
  WebpackAdapterSession,
  WebpackBrowserMessageHandler,
} from './types.js';

interface BrowserEnvelope {
  event: string;
  payload: unknown;
}

export function createWebpackBrowserRouter(
  sessionId: string,
  credential: BrowserTransportCredential,
  manifest: WebpackAdapterSession['manifest'],
  diagnostics: ((message: string) => void) | undefined,
): BrowserRouter {
  return new BrowserRouter({
    sessionId,
    browserToken: credential.browserToken,
    browserAddressPolicy: createBrowserAddressPolicy({ mode: 'loopback' }),
    allowedOrigins: () => credential.allowedOrigins ?? [...credential.observedOrigins],
    resolveSource(sourceId, modifiers) {
      const resolved = manifest.resolveCandidates(sourceId, preferredCandidate(modifiers));
      return resolved.status === 'found'
        ? {
            status: 'found' as const,
            record: resolved.resolution.primary.record,
            candidates: resolved.resolution.candidates,
          }
        : { status: resolved.status };
    },
    diagnostics,
  });
}

export function createBrowserMessageHandler(
  router: BrowserRouter | null,
  userHandler: WebpackBrowserMessageHandler | undefined,
  diagnostics: ((message: string) => void) | undefined,
): WebpackBrowserMessageHandler | undefined {
  if (!router && !userHandler) {
    return undefined;
  }
  return {
    async onConnect(client) {
      await userHandler?.onConnect?.(client);
    },
    async onMessage(value, client) {
      if (router) {
        routeBrowserEnvelope(router, value, client, diagnostics);
      }
      await userHandler?.onMessage?.(value, client);
    },
    async onDisconnect(client) {
      await userHandler?.onDisconnect?.(client);
    },
  };
}

export function ensureWebpackBridge(session: WebpackAdapterSession): void {
  if (
    !session.bridgeEnabled ||
    !session.browserRouter ||
    !session.browserCredential ||
    session.disposed
  ) {
    return;
  }
  session.bridgeStartPromise ??= startBridge(session).catch((error: unknown) => {
    session.diagnostics?.(
      `BRIDGE_START_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  });
  session.browserSweepTimer ??= createSweepTimer(session);
}

export function disposeWebpackBrowserSession(session: WebpackAdapterSession): void {
  if (session.browserSweepTimer) {
    clearInterval(session.browserSweepTimer);
    session.browserSweepTimer = null;
  }
  session.browserRouter?.dispose();
  const disposeBridge = async (): Promise<void> => {
    await session.bridgeStartPromise;
    await session.bridge?.dispose();
    session.bridge = null;
  };
  void disposeBridge().catch((error: unknown) => {
    session.diagnostics?.(
      `BRIDGE_DISPOSE_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

async function startBridge(session: WebpackAdapterSession): Promise<void> {
  const router = session.browserRouter;
  const credential = session.browserCredential;
  if (!router || !credential) {
    return;
  }
  const canonicalRoot = realpathSync.native(session.root);
  const bridge = await createLoopbackBridge({
    session: {
      schemaVersion: SESSION_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.compilerSessionId,
      pid: process.pid,
      bridgePath: createBridgePath(),
      token: createBridgeToken(),
      createdAt: Date.now(),
      projectName: path.basename(canonicalRoot),
      canonicalRoots: [
        {
          rootKey: session.rootKey,
          canonicalPath: canonicalRoot,
          displayName: path.basename(canonicalRoot),
        },
      ],
      devOrigins: credential.allowedOrigins
        ? [...credential.allowedOrigins]
        : [...credential.observedOrigins],
      capabilities: ['vue', 'metadata', 'candidate', 'remote-toggle', 'context-anchor'],
    },
    sessionDirectory: getSessionDirectory(),
    getBrowserTabs: () => router.getTabs(),
    onOpenResult: (result) => router.sendResult(result),
    onConnectionChange: (state) => router.updateConnection(state),
    onSetBrowserMode: (request) => router.setBrowserMode(request),
    onDiagnostics: session.diagnostics,
  });
  if (session.disposed) {
    await bridge.dispose();
    return;
  }
  session.bridge = bridge;
  router.setBridge(bridge);
}

function routeBrowserEnvelope(
  router: BrowserRouter,
  value: unknown,
  client: BrowserTransportClient,
  diagnostics: ((message: string) => void) | undefined,
): void {
  const envelope = asBrowserEnvelope(value);
  if (!envelope) {
    diagnostics?.('INVALID_BROWSER_TRANSPORT_ENVELOPE');
    return;
  }
  switch (envelope.event) {
    case browserEvents.hello:
      router.handleHello(envelope.payload, client);
      break;
    case browserEvents.heartbeat:
      router.handleHeartbeat(envelope.payload, client);
      break;
    case browserEvents.metadataRequest:
      router.handleMetadataRequest(envelope.payload, client);
      break;
    case browserEvents.select:
      router.handleSelection(envelope.payload, client);
      break;
    case browserEvents.dispose:
      router.handleDispose(envelope.payload, client);
      break;
    default:
      diagnostics?.(`UNKNOWN_BROWSER_EVENT:${envelope.event}`);
  }
}

function asBrowserEnvelope(value: unknown): BrowserEnvelope | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.event === 'string'
    ? { event: candidate.event, payload: candidate.payload }
    : null;
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

function createSweepTimer(session: WebpackAdapterSession): ReturnType<typeof setInterval> {
  const timer = setInterval(() => session.browserRouter?.sweepStalePages(), 30_000);
  timer.unref?.();
  return timer;
}
