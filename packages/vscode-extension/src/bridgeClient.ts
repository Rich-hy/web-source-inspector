import { createHash, randomUUID } from 'node:crypto';

import { PROTOCOL_LIMITS, PROTOCOL_VERSION, validateBridgeMessage } from '@web-source-inspector/protocol';
import WebSocket, { type RawData } from 'ws';

import { createEnvelope, parseIncomingBridgeMessage, parseOpenSourcePayload } from './bridgeProtocol';
import type {
  BrowserTab,
  BridgeMessageType,
  BridgePayloadMap,
  IdeHelloPayload,
  IdeOpenResultPayload,
  IdeWorkspaceRoot,
  OpenSourceResult,
  ServerClaimResultPayload,
  ServerHelloAckPayload,
  ServerOpenSourcePayload,
  SessionDescriptor,
} from './types';
import { BRIDGE_SUBPROTOCOL } from './types';

const HEARTBEAT_INTERVAL_MS = 10_000;
const CONNECTION_STALE_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type BridgeConnectionState =
  | 'idle'
  | 'connecting'
  | 'authenticated'
  | 'claimed'
  | 'active'
  | 'reconnecting'
  | 'rejected'
  | 'expired'
  | 'disposed';

export interface IdeIdentity {
  ideClientId: string;
  ideName: string;
  extensionVersion: string;
}

export interface BridgeClientOptions {
  descriptor: SessionDescriptor;
  identity: IdeIdentity;
  workspaceRoots: IdeWorkspaceRoot[];
  capabilities: string[];
  autoClaim: boolean;
  focused: boolean;
  onStateChange?: (state: BridgeConnectionState) => void;
  onTabsChanged?: (tabs: BrowserTab[]) => void;
  onOpenSource: (payload: ServerOpenSourcePayload) => Promise<OpenSourceResult>;
  onDiagnostic?: (code: string) => void;
  random?: () => number;
}

interface CachedOpenResult {
  fingerprint: string;
  result: Promise<OpenSourceResult>;
}

type ClaimIntent = 'none' | 'auto' | 'explicit';

export function computeReconnectDelay(attempt: number, random = Math.random): number {
  const boundedAttempt = Math.min(Math.max(0, attempt), 8);
  const baseDelay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** boundedAttempt);
  const jitter = 0.75 + random() * 0.5;
  return Math.round(baseDelay * jitter);
}

export function buildLoopbackBridgeUrl(descriptor: Pick<SessionDescriptor, 'port' | 'bridgePath'>): string {
  const url = new URL(`ws://127.0.0.1:${descriptor.port}`);
  url.pathname = descriptor.bridgePath;
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'ws:' || url.port !== String(descriptor.port)) {
    throw new Error('LOOPBACK_URL_REJECTED');
  }
  return url.toString();
}

export function createBridgeHandshake(
  descriptor: Pick<SessionDescriptor, 'port' | 'bridgePath' | 'token'>,
): { url: string; subprotocol: typeof BRIDGE_SUBPROTOCOL; headers: { Authorization: string } } {
  return {
    url: buildLoopbackBridgeUrl(descriptor),
    subprotocol: BRIDGE_SUBPROTOCOL,
    headers: { Authorization: `Bearer ${descriptor.token}` },
  };
}

function dataToUtf8(data: RawData): string | undefined {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBrowserTabs(value: unknown): BrowserTab[] | undefined {
  const validated = validateBridgeMessage({
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'tabs-validation',
    type: 'server:tabs-changed',
    sessionId: 'validation-session',
    senderId: 'validation-session',
    timestamp: Date.now(),
    payload: { browserTabs: value },
  });
  if (!validated.ok || validated.value.type !== 'server:tabs-changed') {
    return undefined;
  }
  return validated.value.payload.browserTabs;
}

export function parseServerHelloAckPayload(
  value: unknown,
  expectedSessionId: string,
): ServerHelloAckPayload | undefined {
  const validated = validateBridgeMessage({
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'hello-validation',
    type: 'server:hello-ack',
    sessionId: expectedSessionId,
    senderId: expectedSessionId,
    timestamp: Date.now(),
    payload: value,
  });
  if (!validated.ok || validated.value.type !== 'server:hello-ack') {
    return undefined;
  }
  const payload = validated.value.payload;
  return payload.session.sessionId === expectedSessionId ? payload : undefined;
}

export function createIdeHelloPayload(
  identity: IdeIdentity,
  workspaceRoots: readonly IdeWorkspaceRoot[],
  capabilities: readonly string[],
  focused: boolean,
): IdeHelloPayload {
  return {
    ideClientId: identity.ideClientId,
    ideName: identity.ideName,
    extensionVersion: identity.extensionVersion,
    workspaceRoots: workspaceRoots.slice(0, PROTOCOL_LIMITS.workspaceRootCount).map(({ rootKey, canonicalPath }) => ({
      ...(rootKey ? { rootKey } : {}),
      canonicalPath,
    })),
    capabilities: [...capabilities.slice(0, PROTOCOL_LIMITS.capabilityCount)],
    focused,
  };
}

export function createIdeOpenResultPayload(
  request: ServerOpenSourcePayload,
  result: OpenSourceResult,
): IdeOpenResultPayload {
  return {
    requestMessageId: request.openRequestId,
    ok: result.success,
    ...(result.code !== 'OK' ? { code: result.code } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.success ? { relativePath: request.relativePath } : {}),
    ...(result.success ? { line: result.range?.startLine ?? request.range.startLine } : {}),
    accuracy: result.accuracy ?? request.accuracy,
  };
}

export class BridgeClient {
  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private state: BridgeConnectionState = 'idle';
  private reconnectAttempt = 0;
  private lastServerActivity = 0;
  private disposed = false;
  private fatalRejection = false;
  private focused: boolean;
  private claimIntent: ClaimIntent = 'none';
  private selectedPageClientId: string | undefined;
  private tabs: BrowserTab[] = [];
  private readonly openResults = new Map<string, CachedOpenResult>();
  private readonly browserModes = new Map<string, boolean>();

  public constructor(private readonly options: BridgeClientOptions) {
    this.focused = options.focused;
  }

  public get currentState(): BridgeConnectionState {
    return this.state;
  }

  public get browserTabs(): readonly BrowserTab[] {
    return this.tabs;
  }

  public start(): void {
    if (this.disposed || this.socket) {
      return;
    }
    this.connect(false);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    if (this.isReady()) {
      this.send('ide:claim', { claim: false });
    }
    this.disposed = true;
    this.clearTimers();
    this.socket?.close(1000, 'extension disposed');
    this.socket = undefined;
    this.setState('disposed');
  }

  public setFocused(focused: boolean): void {
    this.focused = focused;
    if (this.isReady()) {
      this.send('ide:focus', { focused });
    }
    if (!focused && this.claimIntent === 'auto') {
      this.releaseAutomaticClaim();
    } else if (focused && this.options.autoClaim && this.claimIntent === 'none') {
      this.requestClaim('auto');
    }
  }

  public claim(pageClientId?: string): void {
    if (pageClientId) {
      this.selectedPageClientId = pageClientId;
    }
    this.requestClaim('explicit');
  }

  public choosePage(pageClientId: string | undefined): void {
    this.selectedPageClientId = pageClientId;
    if (this.isReady()) {
      this.claim();
    }
  }

  public toggleBrowserSelectMode(): boolean {
    if (!this.selectedPageClientId) {
      return false;
    }
    const enabled = !(this.browserModes.get(this.selectedPageClientId) ?? false);
    const sent = this.send('ide:set-browser-mode', {
      pageClientId: this.selectedPageClientId,
      enabled,
    });
    if (sent) {
      this.browserModes.set(this.selectedPageClientId, enabled);
    }
    return sent;
  }

  private connect(isReconnect: boolean): void {
    this.setState(isReconnect ? 'reconnecting' : 'connecting');
    let socket: WebSocket;
    try {
      const handshake = createBridgeHandshake(this.options.descriptor);
      socket = new WebSocket(handshake.url, handshake.subprotocol, {
        headers: handshake.headers,
        followRedirects: false,
        handshakeTimeout: 5_000,
        maxPayload: PROTOCOL_LIMITS.bridgeMessageBytes,
        perMessageDeflate: false,
      });
    } catch {
      this.scheduleReconnect('CONNECT_CREATE_FAILED');
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';

    socket.on('open', () => {
      if (socket.protocol !== BRIDGE_SUBPROTOCOL) {
        this.reject('SUBPROTOCOL_REJECTED');
        socket.close(4002, 'subprotocol rejected');
        return;
      }
      this.lastServerActivity = Date.now();
      this.send(
        'ide:hello',
        createIdeHelloPayload(
          this.options.identity,
          this.options.workspaceRoots,
          this.options.capabilities,
          this.focused,
        ),
      );
      this.startHeartbeat();
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.options.onDiagnostic?.('BINARY_MESSAGE_REJECTED');
        socket.close(1003, 'text messages required');
        return;
      }
      const source = dataToUtf8(data);
      if (source === undefined) {
        this.options.onDiagnostic?.('MESSAGE_DECODE_FAILED');
        return;
      }
      this.lastServerActivity = Date.now();
      void this.handleMessage(source);
    });
    socket.on('pong', () => {
      this.lastServerActivity = Date.now();
    });
    socket.on('error', () => {
      this.options.onDiagnostic?.('BRIDGE_SOCKET_ERROR');
    });
    socket.on('close', (code) => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      this.stopHeartbeat();
      if (code === 4001 || code === 4002 || code === 4003) {
        this.fatalRejection = true;
      }
      if (!this.disposed && !this.fatalRejection) {
        this.scheduleReconnect('BRIDGE_CLOSED');
      } else if (!this.disposed) {
        this.setState('rejected');
      }
    });
  }

  private async handleMessage(rawMessage: string): Promise<void> {
    const parsed = parseIncomingBridgeMessage(rawMessage, this.options.descriptor.sessionId);
    if (!parsed.ok) {
      this.options.onDiagnostic?.(parsed.code);
      if (parsed.code === 'PROTOCOL_MISMATCH') {
        this.reject(parsed.code);
      } else {
        this.socket?.close(1008, 'invalid bridge message');
      }
      return;
    }

    const { message } = parsed;
    switch (message.type) {
      case 'server:hello-ack':
        this.handleHelloAck(message.payload);
        break;
      case 'server:open-source':
        await this.handleOpenSource(message.payload);
        break;
      case 'server:tabs-changed': {
        const tabs = parseBrowserTabs(message.payload.browserTabs);
        if (!tabs) {
          this.options.onDiagnostic?.('INVALID_TABS_CHANGED');
          this.socket?.close(1008, 'invalid tabs payload');
          break;
        }
        this.tabs = tabs;
        for (const pageClientId of this.browserModes.keys()) {
          if (!tabs.some((tab) => tab.pageClientId === pageClientId)) {
            this.browserModes.delete(pageClientId);
          }
        }
        this.options.onTabsChanged?.(tabs);
        break;
      }
      case 'server:claim-result':
        this.handleClaimResult(message.payload);
        break;
      case 'heartbeat':
        break;
      case 'server:session-dispose':
        this.fatalRejection = true;
        this.socket?.close(1000, 'session disposed');
        this.setState('expired');
        break;
      case 'error': {
        const code = message.payload.code;
        if (code === 'AUTH_FAILED' || code === 'PROTOCOL_MISMATCH') {
          this.reject(String(code));
        } else {
          this.options.onDiagnostic?.(typeof code === 'string' ? code : 'REMOTE_ERROR');
        }
        break;
      }
      default:
        this.options.onDiagnostic?.('UNKNOWN_MESSAGE_TYPE');
        break;
    }
  }

  private handleHelloAck(payload: unknown): void {
    const ack = parseServerHelloAckPayload(payload, this.options.descriptor.sessionId);
    if (!ack) {
      this.reject('INVALID_HELLO_ACK');
      return;
    }
    this.tabs = ack.browserTabs;
    this.options.onTabsChanged?.(this.tabs);
    this.reconnectAttempt = 0;
    this.setState('authenticated');
    this.send('ide:focus', { focused: this.focused });
    if (this.claimIntent === 'explicit') {
      this.requestClaim('explicit');
    } else if (this.focused && this.options.autoClaim) {
      this.requestClaim('auto');
    } else {
      this.claimIntent = 'none';
      this.setState('active');
    }
  }

  private requestClaim(intent: Exclude<ClaimIntent, 'none'>): void {
    if (intent === 'auto' && this.claimIntent === 'explicit') {
      return;
    }
    this.claimIntent = intent;
    if (this.isReady()) {
      this.send('ide:claim', { claim: true });
    }
  }

  private releaseAutomaticClaim(): void {
    if (this.claimIntent !== 'auto') {
      return;
    }
    this.claimIntent = 'none';
    if (this.isReady()) {
      this.send('ide:claim', { claim: false });
    }
  }

  private handleClaimResult(payload: unknown): void {
    if (!isRecord(payload) || typeof payload.claimed !== 'boolean') {
      this.options.onDiagnostic?.('INVALID_CLAIM_RESULT');
      this.socket?.close(1008, 'invalid claim result');
      return;
    }
    const result: ServerClaimResultPayload = { claimed: payload.claimed };
    this.setState(result.claimed ? 'claimed' : 'active');
  }

  private async handleOpenSource(payloadValue: unknown): Promise<void> {
    const payload = parseOpenSourcePayload(payloadValue);
    if (!payload) {
      this.options.onDiagnostic?.('INVALID_OPEN_SOURCE');
      this.socket?.close(1008, 'invalid open source payload');
      return;
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const cached = this.openResults.get(payload.openRequestId);
    if (cached && cached.fingerprint !== fingerprint) {
      this.options.onDiagnostic?.('REPLAY_CONFLICT');
      this.socket?.close(1008, 'open request replay conflict');
      return;
    }
    const resultPromise = cached?.result ?? this.options.onOpenSource(payload);
    if (!cached) {
      this.openResults.set(payload.openRequestId, { fingerprint, result: resultPromise });
      if (this.openResults.size > 256) {
        const oldestKey = this.openResults.keys().next().value as string | undefined;
        if (oldestKey) {
          this.openResults.delete(oldestKey);
        }
      }
    }
    let result: OpenSourceResult;
    try {
      result = await resultPromise;
    } catch {
      result = { openRequestId: payload.openRequestId, success: false, code: 'INTERNAL_ERROR' };
    }
    this.send('ide:open-result', createIdeOpenResultPayload(payload, result));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastServerActivity > CONNECTION_STALE_MS) {
        this.options.onDiagnostic?.('HEARTBEAT_TIMEOUT');
        this.socket?.terminate();
        return;
      }
      this.send('heartbeat', {});
      this.socket?.ping();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(code: string): void {
    if (this.disposed || this.fatalRejection || this.reconnectTimer) {
      return;
    }
    this.options.onDiagnostic?.(code);
    const delay = computeReconnectDelay(this.reconnectAttempt, this.options.random);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(true);
    }, delay);
  }

  private reject(code: string): void {
    this.fatalRejection = true;
    this.options.onDiagnostic?.(code);
    this.setState('rejected');
    this.socket?.close(4003, 'connection rejected');
  }

  private send<TType extends BridgeMessageType>(type: TType, payload: BridgePayloadMap[TType]): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const envelope = createEnvelope(
      type,
      payload,
      this.options.descriptor.sessionId,
      this.options.identity.ideClientId,
      randomUUID(),
    );
    this.socket.send(JSON.stringify(envelope));
    return true;
  }

  private isReady(): boolean {
    return this.state === 'authenticated' || this.state === 'claimed' || this.state === 'active';
  }

  private setState(state: BridgeConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.options.onStateChange?.(state);
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
