import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import {
  BRIDGE_SUBPROTOCOL,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  createProtocolEnvelope,
  isProtocolVersionCompatible,
  parseBridgeMessage,
  validateBridgeMessage,
  type BridgeMessage,
  type BridgeMessageType,
  type BridgePayloadMap,
  type ProtocolErrorCode,
  type SessionDescriptor
} from '@web-source-inspector/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type {
  BridgeConnectionState,
  BridgeOpenRequest,
  BridgeOpenResult,
  IdeClientState,
  LoopbackBridge,
  LoopbackBridgeOptions
} from './bridge-types';
import {
  isLoopbackAddress,
  removeSessionDescriptor,
  writeSessionDescriptor
} from './session';

const HEARTBEAT_INTERVAL_MS = 5_000;
const CLIENT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface ConnectedIde extends IdeClientState {
  socket: WebSocket;
}

interface PendingOpenRequest {
  pageClientId: string;
  ideClientId: string;
  timer: ReturnType<typeof setTimeout>;
}

type EnvelopeParseResult =
  | { ok: true; message: BridgeMessage }
  | { ok: false; code: ProtocolErrorCode };

function parseEnvelope(raw: string, sessionId: string): EnvelopeParseResult {
  const parsed = parseBridgeMessage(raw);
  if (!parsed.ok) {
    return { ok: false, code: parsed.error.code };
  }
  const message = parsed.value;
  if (!isProtocolVersionCompatible(message.protocolVersion)) {
    return { ok: false, code: 'PROTOCOL_MISMATCH' };
  }
  if (message.sessionId !== sessionId) {
    return { ok: false, code: 'SESSION_NOT_FOUND' };
  }
  if (Math.abs(Date.now() - message.timestamp) > 10 * 60_000) {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
  return { ok: true, message };
}

function normalizeFileIdentity(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function hasMatchingRoot(client: ConnectedIde, descriptor: SessionDescriptor): boolean {
  return descriptor.canonicalRoots.some((sessionRoot) => client.workspaceRoots.some((workspaceRoot) => (
    workspaceRoot.rootKey === sessionRoot.rootKey
    || normalizeFileIdentity(workspaceRoot.canonicalPath) === normalizeFileIdentity(sessionRoot.canonicalPath)
  )));
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith('Bearer ')) {
    return false;
  }
  const value = actual.slice(7);
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function rejectUpgrade(socket: Socket, status: 400 | 401 | 403 | 404 | 426): void {
  const labels = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required' };
  socket.write(`HTTP/1.1 ${status} ${labels[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function messageDigest(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

export async function createLoopbackBridge(options: LoopbackBridgeOptions): Promise<LoopbackBridge> {
  const httpServer = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: PROTOCOL_LIMITS.bridgeMessageBytes,
    handleProtocols(protocols) {
      return protocols.has(BRIDGE_SUBPROTOCOL) ? BRIDGE_SUBPROTOCOL : false;
    }
  });

  const clients = new Map<string, ConnectedIde>();
  const socketClients = new Map<WebSocket, ConnectedIde>();
  const pendingRequests = new Map<string, PendingOpenRequest>();
  const seenMessages = new Map<string, string>();
  let claimedIdeClientId: string | undefined;
  let descriptorPath = '';
  let disposed = false;

  function diagnostics(message: string): void {
    try {
      options.onDiagnostics?.(message);
    } catch {
      // 诊断回调不能中断 Bridge 生命周期或 descriptor 写队列。
    }
  }

  function send<TType extends BridgeMessageType>(
    socket: WebSocket,
    type: TType,
    payload: BridgePayloadMap[TType],
    messageId: string = randomUUID()
  ): boolean {
    if (socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const envelope = createProtocolEnvelope(type, payload, {
      protocolVersion: PROTOCOL_VERSION,
      messageId,
      sessionId: options.session.sessionId,
      senderId: options.session.sessionId
    });
    const validation = validateBridgeMessage(envelope);
    if (!validation.ok) {
      diagnostics(
        `INVALID_OUTGOING_BRIDGE_MESSAGE:${type}:${validation.error.path}`
      );
      return false;
    }
    socket.send(JSON.stringify(validation.value));
    return true;
  }

  function sendError(
    socket: WebSocket,
    code: ProtocolErrorCode,
    requestMessageId?: string
  ): void {
    send(socket, 'error', { code, requestMessageId });
  }

  function eligibleClients(): ConnectedIde[] {
    return [...clients.values()].filter((client) => client.authenticated && hasMatchingRoot(client, descriptor));
  }

  function selectClient(): ConnectedIde | null | 'ambiguous' {
    const eligible = eligibleClients();
    if (claimedIdeClientId) {
      const claimed = clients.get(claimedIdeClientId);
      if (claimed && eligible.includes(claimed)) {
        return claimed;
      }
      claimedIdeClientId = undefined;
    }
    if (eligible.length === 1) {
      return eligible[0] || null;
    }
    const focused = eligible.filter((client) => client.focused);
    if (focused.length === 1) {
      return focused[0] || null;
    }
    return eligible.length === 0 ? null : 'ambiguous';
  }

  function emitConnectionState(): void {
    const selected = selectClient();
    const state: BridgeConnectionState = selected && selected !== 'ambiguous'
      ? { connected: true, ideName: selected.ideName, ideClientId: selected.ideClientId }
      : { connected: false };
    options.onConnectionChange(state);
  }

  function handleOpenResult(
    client: ConnectedIde,
    envelope: Extract<BridgeMessage, { type: 'ide:open-result' }>
  ): void {
    const payload = envelope.payload;
    const pending = pendingRequests.get(payload.requestMessageId);
    if (!pending || pending.ideClientId !== client.ideClientId) {
      sendError(client.socket, 'UNKNOWN_REQUEST', envelope.messageId);
      return;
    }
    clearTimeout(pending.timer);
    pendingRequests.delete(payload.requestMessageId);
    const result: BridgeOpenResult<ProtocolErrorCode> = {
      openRequestId: payload.requestMessageId,
      pageClientId: pending.pageClientId,
      ok: payload.ok,
      code: payload.code,
      message: payload.message?.slice(0, 240),
      relativePath: payload.relativePath,
      line: payload.line,
      accuracy: payload.accuracy
    };
    options.onOpenResult(result);
  }

  function handleClientMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    const buffer = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.from(data);
    if (isBinary || buffer.byteLength > PROTOCOL_LIMITS.bridgeMessageBytes) {
      socket.close(1009, 'Message too large');
      return;
    }
    const raw = buffer.toString('utf8');
    const parsedEnvelope = parseEnvelope(raw, options.session.sessionId);
    if (!parsedEnvelope.ok) {
      sendError(socket, parsedEnvelope.code);
      return;
    }
    const envelope = parsedEnvelope.message;
    const digest = messageDigest(raw);
    const previousDigest = seenMessages.get(envelope.messageId);
    if (previousDigest) {
      if (previousDigest !== digest) {
        sendError(socket, 'REPLAY_CONFLICT', envelope.messageId);
      }
      return;
    }
    seenMessages.set(envelope.messageId, digest);
    if (seenMessages.size > 2_000) {
      const oldest = seenMessages.keys().next().value;
      if (oldest) {
        seenMessages.delete(oldest);
      }
    }

    if (envelope.type === 'ide:hello') {
      const hello = envelope.payload;
      if (
        envelope.senderId !== hello.ideClientId ||
        clients.has(hello.ideClientId) ||
        socketClients.has(socket)
      ) {
        sendError(socket, 'INVALID_IDE_HELLO', envelope.messageId);
        socket.close(1008, 'Invalid hello');
        return;
      }
      const client: ConnectedIde = {
        socket,
        ideClientId: hello.ideClientId,
        ideName: hello.ideName,
        workspaceRoots: hello.workspaceRoots,
        capabilities: hello.capabilities,
        focused: hello.focused,
        lastFocusAt: hello.focused ? Date.now() : 0,
        lastHeartbeatAt: Date.now(),
        authenticated: true
      };
      if (!hasMatchingRoot(client, descriptor)) {
        sendError(socket, 'WORKSPACE_NOT_MATCHED', envelope.messageId);
        socket.close(1008, 'Workspace not matched');
        return;
      }
      clients.set(client.ideClientId, client);
      socketClients.set(socket, client);
      send(socket, 'server:hello-ack', {
        authenticated: true,
        session: {
          sessionId: descriptor.sessionId,
          projectName: descriptor.projectName,
          canonicalRoots: descriptor.canonicalRoots.map(({ rootKey, displayName }) => ({ rootKey, displayName })),
          capabilities: descriptor.capabilities
        },
        browserTabs: options.getBrowserTabs()
      }, envelope.messageId);
      emitConnectionState();
      return;
    }

    const client = socketClients.get(socket);
    if (!client?.authenticated || envelope.senderId !== client.ideClientId) {
      sendError(socket, 'AUTH_FAILED', envelope.messageId);
      return;
    }
    client.lastHeartbeatAt = Date.now();

    switch (envelope.type) {
      case 'heartbeat':
        send(socket, 'heartbeat', { acknowledged: true }, envelope.messageId);
        break;
      case 'ide:claim': {
        const payload = envelope.payload;
        if (payload.claim) {
          claimedIdeClientId = client.ideClientId;
        } else if (claimedIdeClientId === client.ideClientId) {
          claimedIdeClientId = undefined;
        }
        send(socket, 'server:claim-result', { claimed: claimedIdeClientId === client.ideClientId }, envelope.messageId);
        emitConnectionState();
        break;
      }
      case 'ide:focus': {
        const payload = envelope.payload;
        client.focused = payload.focused;
        client.lastFocusAt = payload.focused ? Date.now() : client.lastFocusAt;
        emitConnectionState();
        break;
      }
      case 'ide:open-result':
        handleOpenResult(client, envelope);
        break;
      case 'ide:set-browser-mode': {
        const payload = envelope.payload;
        options.onSetBrowserMode({
          enabled: payload.enabled,
          pageClientId: payload.pageClientId
        });
        break;
      }
      default:
        sendError(socket, 'UNKNOWN_MESSAGE_TYPE', envelope.messageId);
    }
  }

  function removeClient(socket: WebSocket): void {
    const client = socketClients.get(socket);
    if (!client) {
      return;
    }
    socketClients.delete(socket);
    clients.delete(client.ideClientId);
    if (claimedIdeClientId === client.ideClientId) {
      claimedIdeClientId = undefined;
    }
    for (const [requestId, pending] of pendingRequests) {
      if (pending.ideClientId === client.ideClientId) {
        clearTimeout(pending.timer);
        pendingRequests.delete(requestId);
        options.onOpenResult({
          openRequestId: requestId,
          pageClientId: pending.pageClientId,
          ok: false,
          code: 'IDE_NOT_CONNECTED'
        });
      }
    }
    emitConnectionState();
  }

  httpServer.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const protocols = (request.headers['sec-websocket-protocol'] || '').split(',').map((value) => value.trim());
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      rejectUpgrade(socket, 403);
      return;
    }
    if (request.url !== options.session.bridgePath) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (request.headers.origin) {
      rejectUpgrade(socket, 403);
      return;
    }
    if (!tokenMatches(request.headers.authorization, options.session.token)) {
      rejectUpgrade(socket, 401);
      return;
    }
    if (!protocols.includes(BRIDGE_SUBPROTOCOL)) {
      rejectUpgrade(socket, 426);
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (socket) => {
    const helloTimer = setTimeout(() => {
      if (!socketClients.has(socket)) {
        socket.close(1008, 'Hello required');
      }
    }, 5_000);
    socket.on('message', (data, isBinary) => handleClientMessage(socket, data, isBinary));
    socket.on('close', () => {
      clearTimeout(helloTimer);
      removeClient(socket);
    });
    socket.on('error', () => removeClient(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    httpServer.once('error', onError);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('BRIDGE_PORT_UNAVAILABLE');
  }

  const descriptor: SessionDescriptor = {
    ...options.session,
    port: address.port,
    heartbeatAt: Date.now()
  };
  try {
    descriptorPath = await writeSessionDescriptor(options.sessionDirectory, descriptor);
  } catch (error) {
    webSocketServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    throw error;
  }

  let descriptorWritesClosed = false;
  let descriptorWriteQueue = Promise.resolve();

  function enqueueDescriptorWrite(snapshot: SessionDescriptor): void {
    if (descriptorWritesClosed) {
      return;
    }
    descriptorWriteQueue = descriptorWriteQueue
      .then(() => writeSessionDescriptor(options.sessionDirectory, snapshot))
      .then(() => undefined)
      .catch(() => diagnostics('SESSION_HEARTBEAT_WRITE_FAILED'));
  }

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    descriptor.heartbeatAt = now;
    enqueueDescriptorWrite({
      ...descriptor,
      heartbeatAt: now,
      canonicalRoots: descriptor.canonicalRoots.map((root) => ({ ...root })),
      devOrigins: [...descriptor.devOrigins],
      capabilities: [...descriptor.capabilities]
    });
    for (const client of clients.values()) {
      if (now - client.lastHeartbeatAt > CLIENT_TIMEOUT_MS) {
        client.socket.close(1001, 'Heartbeat timeout');
      } else {
        send(client.socket, 'heartbeat', { serverTime: now });
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  function requestOpenSource(request: BridgeOpenRequest): ReturnType<LoopbackBridge['requestOpenSource']> {
    if (pendingRequests.size >= 128
      || [...pendingRequests.values()].some((pending) => pending.pageClientId === request.pageClientId)) {
      return { accepted: false, code: 'RATE_LIMITED' };
    }
    const selected = selectClient();
    if (!selected) {
      return { accepted: false, code: 'IDE_NOT_CONNECTED' };
    }
    if (selected === 'ambiguous') {
      return { accepted: false, code: 'IDE_SELECTION_REQUIRED' };
    }
    const messageId = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(messageId);
      options.onOpenResult({
        openRequestId: messageId,
        pageClientId: request.pageClientId,
        ok: false,
        code: 'IDE_REQUEST_TIMEOUT'
      });
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(messageId, { pageClientId: request.pageClientId, ideClientId: selected.ideClientId, timer });
    const sent = send(
      selected.socket,
      'server:open-source',
      { ...request, openRequestId: messageId },
      messageId
    );
    if (!sent) {
      clearTimeout(timer);
      pendingRequests.delete(messageId);
      return { accepted: false, code: 'INVALID_MESSAGE' };
    }
    return { accepted: true, messageId };
  }

  function notifyTabsChanged(): void {
    const payload = { browserTabs: options.getBrowserTabs() };
    for (const client of clients.values()) {
      if (hasMatchingRoot(client, descriptor)) {
        send(client.socket, 'server:tabs-changed', payload);
      }
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      return;
    }
    disposed = true;
    descriptorWritesClosed = true;
    clearInterval(heartbeatTimer);
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
    }
    pendingRequests.clear();
    for (const client of clients.values()) {
      send(client.socket, 'server:session-dispose', { reason: 'dev-server-closed' });
      client.socket.close(1001, 'Session disposed');
    }
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await descriptorWriteQueue;
    await removeSessionDescriptor(options.sessionDirectory, descriptorPath).catch(() => undefined);
  }

  return { descriptor, descriptorPath, requestOpenSource, notifyTabsChanged, dispose };
}
