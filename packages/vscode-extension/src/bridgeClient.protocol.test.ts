import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { BridgeClient } from './bridgeClient';
import { createSourceDigest } from './sourceLocation';
import {
  BRIDGE_SUBPROTOCOL,
  type BridgeMessage,
  type BridgeMessageType,
  type BridgePayloadMap,
  type ProtocolEnvelope,
  type SessionDescriptor,
} from './types';

const SESSION_ID = 'session-protocol-test';
const BRIDGE_PATH = '/wsi/protocol-test';
const TOKEN = 'protocol-test-token-with-at-least-32-characters';
const MULTILINE_CONTEXT_BEFORE = '<template>\r\n\t<section v-if="visible">\n    ';
const MULTILINE_CONTEXT_AFTER = '\r\n\t</section>\n</template>';
type WireEnvelope = BridgeMessage;
type OpenResultEnvelope = ProtocolEnvelope<'ide:open-result'>;

function serverEnvelope<TType extends BridgeMessageType>(
  type: TType,
  payload: BridgePayloadMap[TType],
): ProtocolEnvelope<TType> {
  return {
    protocolVersion: '1.0',
    messageId: randomUUID(),
    type,
    sessionId: SESSION_ID,
    senderId: SESSION_ID,
    timestamp: Date.now(),
    payload,
  };
}

function waitFor<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('BRIDGE_TEST_TIMEOUT')), timeoutMs);
    }),
  ]);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('BRIDGE_TEST_TIMEOUT');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

interface ClaimEvent {
  ideClientId: string;
  claim: boolean;
}

interface ClaimTestServer {
  port: number;
  claimEvents: ClaimEvent[];
  selectedIdeClientId(): string | undefined;
  connectionCount(ideClientId: string): number;
  closeClient(ideClientId: string): void;
  dispose(): Promise<void>;
}

async function createClaimTestServer(): Promise<ClaimTestServer> {
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(BRIDGE_SUBPROTOCOL) ? BRIDGE_SUBPROTOCOL : false),
  });
  const clients = new Map<WebSocket, { ideClientId: string; focused: boolean }>();
  const socketsByClientId = new Map<string, WebSocket>();
  const connectionCounts = new Map<string, number>();
  const claimEvents: ClaimEvent[] = [];
  let claimedClient: { ideClientId: string; socket: WebSocket } | undefined;

  httpServer.on('upgrade', (request, socket: Socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });
  webSocketServer.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8')) as WireEnvelope;
      if (message.type === 'ide:hello') {
        const ideClientId = String(message.payload.ideClientId);
        const client = { ideClientId, focused: message.payload.focused === true };
        clients.set(socket, client);
        socketsByClientId.set(ideClientId, socket);
        connectionCounts.set(ideClientId, (connectionCounts.get(ideClientId) ?? 0) + 1);
        socket.send(
          JSON.stringify(
            serverEnvelope('server:hello-ack', {
              authenticated: true,
              session: {
                sessionId: SESSION_ID,
                projectName: 'claim fixture',
                canonicalRoots: [{ rootKey: 'root-1', displayName: 'fixture' }],
                capabilities: ['open-source'],
              },
              browserTabs: [{ pageClientId: 'page-1', pathname: '/', title: 'Fixture', connectedAt: Date.now() }],
            }),
          ),
        );
        return;
      }

      const client = clients.get(socket);
      if (!client) {
        return;
      }
      if (message.type === 'ide:focus' && typeof message.payload.focused === 'boolean') {
        client.focused = message.payload.focused;
      }
      if (message.type === 'ide:claim' && typeof message.payload.claim === 'boolean') {
        const claim = message.payload.claim;
        claimEvents.push({ ideClientId: client.ideClientId, claim });
        if (claim) {
          claimedClient = { ideClientId: client.ideClientId, socket };
        } else if (claimedClient?.socket === socket) {
          claimedClient = undefined;
        }
        socket.send(
          JSON.stringify(
            serverEnvelope('server:claim-result', {
              claimed: claimedClient?.socket === socket,
            }),
          ),
        );
      }
    });
    socket.on('close', () => {
      const client = clients.get(socket);
      clients.delete(socket);
      if (client && socketsByClientId.get(client.ideClientId) === socket) {
        socketsByClientId.delete(client.ideClientId);
      }
      if (claimedClient?.socket === socket) {
        claimedClient = undefined;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('BRIDGE_TEST_PORT_UNAVAILABLE');
  }

  return {
    port: address.port,
    claimEvents,
    selectedIdeClientId() {
      if (claimedClient) {
        return claimedClient.ideClientId;
      }
      const focusedClients = [...clients.values()].filter((client) => client.focused);
      return focusedClients.length === 1 ? focusedClients[0]?.ideClientId : undefined;
    },
    connectionCount(ideClientId) {
      return connectionCounts.get(ideClientId) ?? 0;
    },
    closeClient(ideClientId) {
      socketsByClientId.get(ideClientId)?.terminate();
    },
    async dispose() {
      for (const socket of webSocketServer.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function createClaimClient(port: number, ideClientId: string, focused: boolean): BridgeClient {
  return new BridgeClient({
    descriptor: {
      schemaVersion: 1,
      protocolVersion: '1.0',
      sessionId: SESSION_ID,
      pid: process.pid,
      port,
      bridgePath: BRIDGE_PATH,
      token: TOKEN,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
      projectName: 'claim fixture',
      canonicalRoots: [{ rootKey: 'root-1', canonicalPath: 'D:\\project', displayName: 'fixture' }],
      devOrigins: ['http://localhost:5173'],
      capabilities: ['open-source'],
    },
    identity: { ideClientId, ideName: 'VS Code', extensionVersion: '0.1.0' },
    workspaceRoots: [{ rootKey: 'root-1', canonicalPath: 'D:\\project' }],
    capabilities: ['open-source'],
    autoClaim: true,
    focused,
    onOpenSource: async (payload) => ({
      openRequestId: payload.openRequestId,
      success: true,
      code: 'OK',
    }),
    random: () => 0,
  });
}

describe('BridgeClient Vite bridge protocol', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
  });

  it('completes hello, focus, claim, open-source, and open-result with the server wire contract', async () => {
    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has(BRIDGE_SUBPROTOCOL) ? BRIDGE_SUBPROTOCOL : false),
    });
    let authorization: string | undefined;
    let requestedProtocols: string | undefined;
    const received: WireEnvelope[] = [];

    httpServer.on('upgrade', (request, socket: Socket, head) => {
      authorization = request.headers.authorization;
      requestedProtocols = request.headers['sec-websocket-protocol'];
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('BRIDGE_TEST_PORT_UNAVAILABLE');
    }

    let resolveOpenResult: (message: OpenResultEnvelope) => void = () => undefined;
    const openResult = new Promise<OpenResultEnvelope>((resolve) => {
      resolveOpenResult = resolve;
    });
    webSocketServer.on('connection', (socket: WebSocket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString('utf8')) as WireEnvelope;
        received.push(message);
        if (message.type === 'ide:hello') {
          socket.send(
            JSON.stringify(
              serverEnvelope('server:hello-ack', {
                authenticated: true,
                session: {
                  sessionId: SESSION_ID,
                  projectName: 'protocol fixture',
                  canonicalRoots: [{ rootKey: 'root-1', displayName: 'fixture' }],
                  capabilities: ['open-source', 'browser-mode'],
                },
                browserTabs: [
                  { pageClientId: 'page-1', pathname: '/fixture', title: 'Fixture', connectedAt: Date.now() },
                ],
              }),
            ),
          );
        }
        if (message.type === 'ide:claim' && message.payload.claim === true) {
          socket.send(JSON.stringify(serverEnvelope('server:claim-result', { claimed: true })));
          socket.send(
            JSON.stringify(
              serverEnvelope('server:open-source', {
                openRequestId: 'open-1',
                pageClientId: 'page-1',
                rootKey: 'root-1',
                relativePath: 'src/App.vue',
                range: {
                  startLine: 2,
                  startColumn: 3,
                  endLine: 2,
                  endColumn: 8,
                  startOffset: 10,
                  endOffset: 15,
                },
                sourceDigest: createSourceDigest('<template><div /></template>'),
                contextBefore: MULTILINE_CONTEXT_BEFORE,
                contextAfter: MULTILINE_CONTEXT_AFTER,
                accuracy: 'exact',
                candidateKind: 'element',
                tagName: 'div',
                componentName: null,
                candidates: [
                  {
                    candidateKind: 'component',
                    label: 'App component',
                    rootKey: 'root-1',
                    relativePath: 'src/App.vue',
                    range: {
                      startLine: 1,
                      startColumn: 1,
                      endLine: 3,
                      endColumn: 12,
                      startOffset: 0,
                      endOffset: 30,
                    },
                    sourceDigest: createSourceDigest('<template><div /></template>'),
                    contextBefore: '<template>\n\t',
                    contextAfter: '\r\n</template>',
                    accuracy: 'exact',
                  },
                ],
                page: { origin: 'http://localhost:5173', pathname: '/fixture', title: 'Fixture' },
              }),
            ),
          );
        }
        if (message.type === 'ide:open-result') {
          resolveOpenResult(message);
        }
      });
    });

    const descriptor: SessionDescriptor = {
      schemaVersion: 1,
      protocolVersion: '1.0',
      sessionId: SESSION_ID,
      pid: process.pid,
      port: address.port,
      bridgePath: BRIDGE_PATH,
      token: TOKEN,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
      projectName: 'protocol fixture',
      canonicalRoots: [{ rootKey: 'root-1', canonicalPath: 'D:\\project', displayName: 'fixture' }],
      devOrigins: ['http://localhost:5173'],
      capabilities: ['open-source', 'browser-mode'],
    };
    let receivedCandidateCount = 0;
    let receivedContexts: Record<string, string | null> | undefined;
    const client = new BridgeClient({
      descriptor,
      identity: { ideClientId: 'ide-client-1', ideName: 'VS Code', extensionVersion: '0.1.0' },
      workspaceRoots: [{ rootKey: 'root-1', canonicalPath: 'D:\\project' }],
      capabilities: ['open-source', 'browser-mode'],
      autoClaim: true,
      focused: true,
      onOpenSource: async (payload) => {
        receivedCandidateCount = payload.candidates.length;
        receivedContexts = {
          contextBefore: payload.contextBefore,
          contextAfter: payload.contextAfter,
          candidateContextBefore: payload.candidates[0]?.contextBefore ?? null,
          candidateContextAfter: payload.candidates[0]?.contextAfter ?? null,
        };
        return {
          openRequestId: payload.openRequestId,
          success: true,
          code: 'OK',
          range: payload.range,
          accuracy: payload.accuracy,
        };
      },
    });
    cleanup.push(async () => {
      client.dispose();
      for (const socket of webSocketServer.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    client.start();
    const resultMessage = await waitFor(openResult);

    expect(authorization).toBe(`Bearer ${TOKEN}`);
    expect(requestedProtocols).toBe(BRIDGE_SUBPROTOCOL);
    expect(received.find((message) => message.type === 'ide:hello')?.payload).toEqual({
      ideClientId: 'ide-client-1',
      ideName: 'VS Code',
      extensionVersion: '0.1.0',
      workspaceRoots: [{ rootKey: 'root-1', canonicalPath: 'D:\\project' }],
      capabilities: ['open-source', 'browser-mode'],
      focused: true,
    });
    expect(received.some((message) => message.type === 'ide:focus' && message.payload.focused === true)).toBe(true);
    expect(received.some((message) => message.type === 'ide:claim' && message.payload.claim === true)).toBe(true);
    expect(receivedCandidateCount).toBe(1);
    expect(receivedContexts).toEqual({
      contextBefore: MULTILINE_CONTEXT_BEFORE,
      contextAfter: MULTILINE_CONTEXT_AFTER,
      candidateContextBefore: '<template>\n\t',
      candidateContextAfter: '\r\n</template>',
    });
    expect(resultMessage.payload).toEqual({
      requestMessageId: 'open-1',
      ok: true,
      relativePath: 'src/App.vue',
      line: 2,
      accuracy: 'exact',
    });
  });

  it('does not let a background client claim on initial connection or reconnect', async () => {
    const server = await createClaimTestServer();
    const foregroundClient = createClaimClient(server.port, 'ide-foreground', true);
    const backgroundClient = createClaimClient(server.port, 'ide-background', false);
    cleanup.push(async () => {
      foregroundClient.dispose();
      backgroundClient.dispose();
      await server.dispose();
    });

    foregroundClient.start();
    await waitUntil(
      () => server.claimEvents.some((event) => event.ideClientId === 'ide-foreground' && event.claim),
    );
    backgroundClient.start();
    await waitUntil(() => server.connectionCount('ide-background') === 1 && backgroundClient.currentState === 'active');

    expect(server.selectedIdeClientId()).toBe('ide-foreground');
    expect(server.claimEvents.some((event) => event.ideClientId === 'ide-background' && event.claim)).toBe(false);

    server.closeClient('ide-background');
    await waitUntil(() => server.connectionCount('ide-background') === 2 && backgroundClient.currentState === 'active');

    expect(server.selectedIdeClientId()).toBe('ide-foreground');
    expect(server.claimEvents.some((event) => event.ideClientId === 'ide-background' && event.claim)).toBe(false);
  });

  it('releases an automatic claim on blur but restores an explicit page claim after reconnect', async () => {
    const server = await createClaimTestServer();
    const firstClient = createClaimClient(server.port, 'ide-first', true);
    const secondClient = createClaimClient(server.port, 'ide-second', false);
    cleanup.push(async () => {
      firstClient.dispose();
      secondClient.dispose();
      await server.dispose();
    });

    firstClient.start();
    secondClient.start();
    await waitUntil(
      () => server.claimEvents.some((event) => event.ideClientId === 'ide-first' && event.claim),
    );

    firstClient.setFocused(false);
    await waitUntil(
      () => server.claimEvents.some((event) => event.ideClientId === 'ide-first' && event.claim === false),
    );
    secondClient.setFocused(true);
    await waitUntil(() => server.selectedIdeClientId() === 'ide-second');

    firstClient.choosePage('page-1');
    await waitUntil(() => server.selectedIdeClientId() === 'ide-first');
    const releaseCountAfterExplicitClaim = server.claimEvents.filter(
      (event) => event.ideClientId === 'ide-first' && event.claim === false,
    ).length;
    firstClient.setFocused(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(server.selectedIdeClientId()).toBe('ide-first');
    expect(
      server.claimEvents.filter((event) => event.ideClientId === 'ide-first' && event.claim === false),
    ).toHaveLength(releaseCountAfterExplicitClaim);

    server.closeClient('ide-first');
    await waitUntil(() => server.selectedIdeClientId() === 'ide-second');
    await waitUntil(() => server.connectionCount('ide-first') === 2 && server.selectedIdeClientId() === 'ide-first');

    expect(firstClient.currentState).toBe('claimed');
    expect(
      server.claimEvents.filter((event) => event.ideClientId === 'ide-first' && event.claim === true).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
