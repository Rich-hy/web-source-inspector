import { timingSafeEqual } from 'node:crypto';
import type { ResolvedSourceCandidate, SourceRecord } from '@web-source-inspector/compiler-core';
import {
  BROWSER_PAGE_TTL_MS,
  BROWSER_EVENTS,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  utf8ByteLength,
  validateBrowserToServerPayload,
  validateServerToBrowserPayload,
  type BrowserClientContext,
  type BrowserToServerEvent,
  type BrowserToServerPayloadMap,
  type ServerToBrowserEvent
} from '@web-source-inspector/protocol';
import {
  isBrowserOriginAuthorized,
  type BrowserAddressPolicy
} from './browser-address';
import type {
  BridgeConnectionState,
  BridgeOpenRequest,
  BridgeOpenResult,
  BridgeSetModeRequest,
  BrowserTabSummary,
  LoopbackBridge
} from './bridge-types';

/** Adapter 提供的 bundler-neutral Browser 连接。 */
export interface BrowserTransportClient {
  send(event: string, payload: unknown): void;
  readonly remoteAddress?: string | null;
  /** 缺省时按活动连接处理，避免未知连接接管 pageClientId。 */
  isOpen?(): boolean;
}

interface PageClient {
  id: string;
  client: BrowserTransportClient;
  pathname: string;
  origin: string;
  normalizedRemoteAddress: string;
  remoteAddressLoopback: boolean;
  title: string;
  connectedAt: number;
  lastSeenAt: number;
  lastSelectionAt: number;
}

export interface BrowserRouterOptions {
  sessionId: string;
  browserToken: string;
  browserAddressPolicy: BrowserAddressPolicy;
  allowedOrigins: readonly string[] | (() => readonly string[]);
  resolveSource: (
    sourceId: string,
    modifiers: { shift: boolean; alt: boolean }
  ) => { status: 'found'; record: SourceRecord; candidates?: ResolvedSourceCandidate[] }
    | { status: 'stale' | 'not-found' };
  diagnostics?: (message: string) => void;
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function isRecentTimestamp(value: number): boolean {
  return Math.abs(Date.now() - value) <= 10 * 60_000;
}

function payloadWithinLimit(payload: unknown): boolean {
  try {
    return utf8ByteLength(JSON.stringify(payload)) <= PROTOCOL_LIMITS.browserMessageBytes;
  } catch {
    return false;
  }
}

function publicMetadata(
  record: SourceRecord,
  sessionId: string,
  pageClientId: string
): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    pageClientId,
    timestamp: Date.now(),
    sourceId: record.sourceId,
    tagName: record.tagName,
    componentName: record.componentName || undefined,
    controlFlow: record.controlFlow?.kind
  };
}

export class BrowserRouter {
  readonly #options: BrowserRouterOptions;
  readonly #pages = new Map<string, PageClient>();
  readonly #clientBindings = new WeakMap<object, string>();
  readonly #pendingRoutes = new Map<string, {
    pageClientId: string;
    client: BrowserTransportClient;
    requestId?: string;
  }>();
  #bridge: LoopbackBridge | null = null;
  #connection: BridgeConnectionState = { connected: false };
  #disposed = false;

  constructor(options: BrowserRouterOptions) {
    this.#options = options;
  }

  setBridge(bridge: LoopbackBridge): void {
    if (this.#disposed) {
      return;
    }
    this.#bridge = bridge;
    bridge.notifyTabsChanged();
  }

  handleHello(payload: unknown, client: BrowserTransportClient): void {
    if (this.#disposed) {
      return;
    }
    const validated = this.validateIncomingPayload(BROWSER_EVENTS.hello, payload);
    if (!validated) {
      return;
    }
    const addressAuthorization = this.#options.browserAddressPolicy.authorize(
      client.remoteAddress
    );
    if (!addressAuthorization.allowed) {
      this.#options.diagnostics?.(
        this.#options.browserAddressPolicy.mode === 'loopback'
          ? 'REMOTE_BROWSER_REJECTED'
          : 'BROWSER_SAME_MACHINE_REJECTED'
      );
      this.sendRejectedConnection(client, validated.pageClientId);
      return;
    }
    if (!isBrowserOriginAuthorized({
      mode: this.#options.browserAddressPolicy.mode,
      normalizedRemoteAddress: addressAuthorization.normalizedAddress,
      remoteAddressLoopback: addressAuthorization.loopback,
      origin: validated.page.origin,
      allowedOrigins: this.getAllowedOrigins()
    })) {
      this.#options.diagnostics?.('BROWSER_ORIGIN_REJECTED');
      this.sendRejectedConnection(client, validated.pageClientId);
      return;
    }

    const pageClientId = validated.pageClientId;
    const currentBinding = this.#clientBindings.get(client as object);
    if (currentBinding && currentBinding !== pageClientId) {
      return;
    }
    const previousPage = this.#pages.get(pageClientId);
    const isNewConnection = !previousPage || previousPage.client !== client;
    if (previousPage && previousPage.client !== client) {
      if (previousPage.client.isOpen?.() ?? true) {
        this.#options.diagnostics?.('PAGE_CLIENT_ID_CONFLICT');
        return;
      }
      this.#clientBindings.delete(previousPage.client as object);
      this.#pages.delete(pageClientId);
    }
    const now = Date.now();
    this.#pages.set(pageClientId, {
      id: pageClientId,
      client,
      origin: validated.page.origin,
      pathname: validated.page.pathname,
      normalizedRemoteAddress: addressAuthorization.normalizedAddress,
      remoteAddressLoopback: addressAuthorization.loopback,
      title: validated.page.title,
      connectedAt: previousPage?.connectedAt || now,
      lastSeenAt: now,
      lastSelectionAt: previousPage?.lastSelectionAt || 0
    });
    this.#clientBindings.set(client as object, pageClientId);
    this.sendConnection(pageClientId);
    if (isNewConnection) {
      this.#bridge?.notifyTabsChanged();
    }
  }

  handleMetadataRequest(payload: unknown, client: BrowserTransportClient): void {
    if (this.#disposed) {
      return;
    }
    const validated = this.validateIncomingPayload(
      BROWSER_EVENTS.metadataRequest,
      payload
    );
    if (!validated) {
      return;
    }
    const page = this.boundPage(validated, client);
    if (!page) {
      return;
    }
    page.lastSeenAt = Date.now();
    const resolved = this.#options.resolveSource(validated.sourceId, { shift: false, alt: false });
    if (resolved.status === 'found') {
      this.sendBrowserPayload(
        page.client,
        BROWSER_EVENTS.metadata,
        publicMetadata(
          resolved.record,
          this.#options.sessionId,
          page.id
        )
      );
    }
  }

  handleSelection(payload: unknown, client: BrowserTransportClient): void {
    if (this.#disposed) {
      return;
    }
    const validated = this.validateIncomingPayload(BROWSER_EVENTS.select, payload);
    if (!validated) {
      return;
    }
    const page = this.boundPage(validated, client);
    if (!page) {
      return;
    }
    if (
      validated.page.origin !== page.origin ||
      validated.page.pathname !== page.pathname ||
      !this.isPageOriginAuthorized(page, validated.page.origin)
    ) {
      this.#options.diagnostics?.('BROWSER_PAGE_BINDING_REJECTED');
      return;
    }
    const now = Date.now();
    if (now - page.lastSelectionAt < 250) {
      this.sendResult({
        pageClientId: page.id,
        requestId: validated.requestId,
        ok: false,
        code: 'RATE_LIMITED'
      });
      return;
    }
    page.lastSelectionAt = now;
    page.lastSeenAt = now;

    const resolved = this.#options.resolveSource(validated.sourceId, {
      shift: validated.modifiers.shift,
      alt: validated.modifiers.alt
    });
    if (resolved.status !== 'found') {
      this.sendResult({
        pageClientId: page.id,
        requestId: validated.requestId,
        ok: false,
        code: resolved.status === 'stale' ? 'SOURCE_STALE' : 'SOURCE_NOT_FOUND'
      });
      return;
    }
    if (!this.#bridge) {
      this.sendResult({
        pageClientId: page.id,
        requestId: validated.requestId,
        ok: false,
        code: 'IDE_NOT_CONNECTED'
      });
      return;
    }
    const record = resolved.record;
    const request: BridgeOpenRequest = {
      pageClientId: page.id,
      rootKey: record.rootKey,
      relativePath: record.relativePath,
      range: record.range,
      sourceDigest: record.sourceDigest,
      contextBefore: record.contextBefore,
      contextAfter: record.contextAfter,
      accuracy: record.accuracy,
      candidateKind: record.kind,
      tagName: record.tagName,
      componentName: record.componentName,
      candidates: (resolved.candidates || [])
        .slice(0, PROTOCOL_LIMITS.candidateCount)
        .map((candidate) => ({
        candidateKind: candidate.candidateKind,
        label: candidate.label,
        rootKey: candidate.rootKey,
        relativePath: candidate.relativePath,
        range: candidate.range,
        sourceDigest: candidate.sourceDigest,
        contextBefore: candidate.contextBefore,
        contextAfter: candidate.contextAfter,
        accuracy: candidate.accuracy
        })),
      page: validated.page
    };
    const result = this.#bridge.requestOpenSource(request);
    if (!result.accepted) {
      this.sendResult({
        pageClientId: page.id,
        requestId: validated.requestId,
        ok: false,
        code: result.code
      });
    } else {
      this.#pendingRoutes.set(result.messageId, {
        pageClientId: page.id,
        client: page.client,
        requestId: validated.requestId
      });
    }
  }

  handleDispose(payload: unknown, client: BrowserTransportClient): void {
    if (this.#disposed) {
      return;
    }
    const validated = this.validateIncomingPayload(BROWSER_EVENTS.dispose, payload);
    if (!validated) {
      return;
    }
    const page = this.boundPage(validated, client);
    if (!page) {
      return;
    }
    this.#pages.delete(page.id);
    if (this.#clientBindings.get(client as object) === page.id) {
      this.#clientBindings.delete(client as object);
    }
    this.#bridge?.notifyTabsChanged();
  }

  handleHeartbeat(payload: unknown, client: BrowserTransportClient): void {
    if (this.#disposed) {
      return;
    }
    const validated = this.validateIncomingPayload(BROWSER_EVENTS.heartbeat, payload);
    if (!validated) {
      return;
    }
    const page = this.boundPage(validated, client);
    if (!page) {
      return;
    }
    page.lastSeenAt = Date.now();
    this.sendBrowserPayload(page.client, BROWSER_EVENTS.heartbeatAck, {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.#options.sessionId,
      pageClientId: page.id,
      timestamp: Date.now(),
      sequence: validated.sequence,
      acknowledged: true,
      serverTime: Date.now()
    });
  }

  updateConnection(state: BridgeConnectionState): void {
    if (this.#disposed) {
      return;
    }
    this.#connection = state;
    for (const page of this.#pages.values()) {
      this.sendConnection(page.id);
    }
  }

  sendResult(result: BridgeOpenResult & { requestId?: string }): void {
    if (this.#disposed) {
      return;
    }
    const { openRequestId, requestId } = result;
    const route = openRequestId ? this.#pendingRoutes.get(openRequestId) : undefined;
    if (openRequestId) {
      this.#pendingRoutes.delete(openRequestId);
    }
    const client = route?.pageClientId === result.pageClientId
      ? route.client
      : this.#pages.get(result.pageClientId)?.client;
    if (!client) {
      return;
    }
    this.sendBrowserPayload(client, BROWSER_EVENTS.result, {
      pageClientId: result.pageClientId,
      ok: result.ok,
      ...(result.code ? { code: result.code } : {}),
      ...(result.message ? { message: result.message.slice(0, 240) } : {}),
      ...(route?.requestId || requestId ? { requestId: route?.requestId || requestId } : {}),
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.#options.sessionId,
      timestamp: Date.now()
    });
  }

  setBrowserMode(request: BridgeSetModeRequest): void {
    if (this.#disposed) {
      return;
    }
    if (request.pageClientId) {
      const client = this.#pages.get(request.pageClientId)?.client;
      if (!client) {
        return;
      }
      this.sendBrowserPayload(client, BROWSER_EVENTS.setMode, {
        ...request,
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.#options.sessionId,
        pageClientId: request.pageClientId,
        timestamp: Date.now()
      });
      return;
    }
    for (const page of this.#pages.values()) {
      this.sendBrowserPayload(page.client, BROWSER_EVENTS.setMode, {
        ...request,
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.#options.sessionId,
        pageClientId: page.id,
        timestamp: Date.now()
      });
    }
  }

  getTabs(): BrowserTabSummary[] {
    if (this.#disposed) {
      return [];
    }
    this.pruneStalePages();
    return [...this.#pages.values()].map((page) => ({
      pageClientId: page.id,
      pathname: page.pathname,
      title: page.title,
      connectedAt: page.connectedAt
    }));
  }

  sweepStalePages(): void {
    if (this.pruneStalePages()) {
      this.#bridge?.notifyTabsChanged();
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#pages.clear();
    this.#pendingRoutes.clear();
    this.#bridge = null;
    this.#connection = { connected: false };
  }

  private boundPage(
    payload: BrowserClientContext,
    client: BrowserTransportClient
  ): PageClient | null {
    if (this.#clientBindings.get(client as object) !== payload.pageClientId) {
      return null;
    }
    const page = this.#pages.get(payload.pageClientId);
    return page?.client === client ? page : null;
  }

  private sendConnection(pageClientId: string): void {
    const page = this.#pages.get(pageClientId);
    if (!page) {
      return;
    }
    this.sendBrowserPayload(page.client, BROWSER_EVENTS.connection, {
      pageClientId,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.#options.sessionId,
      timestamp: Date.now(),
      connected: this.#connection.connected,
      ideName: this.#connection.ideName
    });
  }

  private sendRejectedConnection(
    client: BrowserTransportClient,
    pageClientId: string
  ): void {
    this.sendBrowserPayload(client, BROWSER_EVENTS.connection, {
      pageClientId,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.#options.sessionId,
      timestamp: Date.now(),
      connected: false,
      message: '当前浏览器地址未授权'
    });
  }

  private pruneStalePages(): boolean {
    const cutoff = Date.now() - BROWSER_PAGE_TTL_MS;
    let changed = false;
    for (const [pageClientId, page] of this.#pages) {
      if (page.lastSeenAt < cutoff) {
        this.#pages.delete(pageClientId);
        if (this.#clientBindings.get(page.client as object) === pageClientId) {
          this.#clientBindings.delete(page.client as object);
        }
        changed = true;
      }
    }
    return changed;
  }

  private validateIncomingPayload<TEvent extends BrowserToServerEvent>(
    event: TEvent,
    payload: unknown
  ): BrowserToServerPayloadMap[TEvent] | null {
    if (!payloadWithinLimit(payload)) {
      return null;
    }
    const result = validateBrowserToServerPayload(event, payload);
    if (!result.ok) {
      return null;
    }
    const value = result.value;
    if (
      value.sessionId !== this.#options.sessionId ||
      !tokenMatches(value.browserToken, this.#options.browserToken) ||
      !isRecentTimestamp(value.timestamp)
    ) {
      return null;
    }
    return value;
  }

  private sendBrowserPayload(
    client: BrowserTransportClient,
    event: ServerToBrowserEvent,
    payload: unknown
  ): void {
    const result = validateServerToBrowserPayload(event, payload);
    if (!result.ok) {
      this.#options.diagnostics?.(
        `INVALID_SERVER_BROWSER_PAYLOAD:${event}:${result.error.path}`
      );
      return;
    }
    client.send(event, result.value);
  }

  private getAllowedOrigins(): readonly string[] {
    return typeof this.#options.allowedOrigins === 'function'
      ? this.#options.allowedOrigins()
      : this.#options.allowedOrigins;
  }

  private isPageOriginAuthorized(page: PageClient, origin: string): boolean {
    return isBrowserOriginAuthorized({
      mode: this.#options.browserAddressPolicy.mode,
      normalizedRemoteAddress: page.normalizedRemoteAddress,
      remoteAddressLoopback: page.remoteAddressLoopback,
      origin,
      allowedOrigins: this.getAllowedOrigins()
    });
  }
}

export { BROWSER_EVENTS as browserEvents };
