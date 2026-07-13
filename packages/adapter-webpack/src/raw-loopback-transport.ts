import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import WebSocket, { WebSocketServer, type RawData } from 'ws';

import { DEFAULT_BROWSER_CONNECTION_CAPACITY, DEFAULT_BROWSER_MESSAGE_BYTES } from './constants.js';
import {
  normalizeAllowedOrigins,
  requestPathname,
  validateWebSocketUpgrade,
} from './browser-security.js';
import { WebpackAdapterError } from './errors.js';
import type {
  RawLoopbackBrowserTransport,
  RawLoopbackBrowserTransportOptions,
  WebpackBrowserClientContext,
} from './types.js';

export function createRawLoopbackBrowserTransport(
  options: RawLoopbackBrowserTransportOptions,
): RawLoopbackBrowserTransport {
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
  if (allowedOrigins.some((origin) => new URL(origin).protocol !== 'http:')) {
    throw new WebpackAdapterError(
      'INVALID_BROWSER_TRANSPORT_CONFIG',
      'raw loopback 首版不支持 HTTPS 页面；请显式挂载同源 WDS middleware',
    );
  }
  const maximumMessageBytes = options.maximumMessageBytes ?? DEFAULT_BROWSER_MESSAGE_BYTES;
  const connectionCapacity = options.connectionCapacity ?? DEFAULT_BROWSER_CONNECTION_CAPACITY;
  assertPositiveLimit(maximumMessageBytes, 'maximumMessageBytes');
  assertPositiveLimit(connectionCapacity, 'connectionCapacity');

  if (
    options.credential &&
    (!/^\/__wsi\/raw\/[A-Za-z0-9_-]+$/.test(options.credential.path) ||
      !/^[A-Za-z0-9_-]{43}$/.test(options.credential.browserToken))
  ) {
    throw new WebpackAdapterError(
      'INVALID_BROWSER_TRANSPORT_CONFIG',
      'raw transport credential 格式无效',
    );
  }
  const descriptor = Object.freeze({
    path: options.credential?.path ?? `/__wsi/raw/${randomBytes(18).toString('base64url')}`,
    browserToken: options.credential?.browserToken ?? randomBytes(32).toString('base64url'),
    allowedOrigins: Object.freeze(allowedOrigins),
  });
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: maximumMessageBytes,
    handleProtocols(protocols) {
      return protocols.has('wsi-browser-v1') ? 'wsi-browser-v1' : false;
    },
  });
  const clients = new Map<WebSocket, WebpackBrowserClientContext>();
  const pendingContexts = new WeakMap<IncomingMessage, WebpackBrowserClientContext>();
  let disposed = false;
  const heartbeat = setInterval(() => {
    if (disposed) {
      return;
    }
    for (const socket of clients.keys()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      }
    }
  }, 15_000);
  heartbeat.unref?.();

  server.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const context = pendingContexts.get(request);
    pendingContexts.delete(request);
    if (disposed || !context) {
      socket.terminate();
      return;
    }
    clients.set(socket, context);
    void Promise.resolve(options.browserMessageHandler?.onConnect?.(context)).catch(() => {
      if (disposed) {
        socket.terminate();
      } else {
        socket.close(1008, 'CONNECT_HANDLER_FAILED');
      }
    });
    socket.on('message', (data: RawData) => {
      if (disposed) {
        socket.terminate();
        return;
      }
      const messageBuffer = rawDataToBuffer(data);
      if (messageBuffer.byteLength > maximumMessageBytes) {
        socket.close(1009, 'MESSAGE_TOO_LARGE');
        return;
      }
      try {
        const payload = JSON.parse(messageBuffer.toString('utf8')) as unknown;
        void Promise.resolve(options.browserMessageHandler?.onMessage?.(payload, context)).catch(() => {
          if (disposed) {
            socket.terminate();
          } else {
            socket.close(1008, 'INVALID_MESSAGE');
          }
        });
      } catch {
        socket.close(1008, 'INVALID_MESSAGE');
      }
    });
    socket.once('close', () => {
      const wasActive = clients.delete(socket);
      if (!wasActive || disposed) {
        return;
      }
      void Promise.resolve(options.browserMessageHandler?.onDisconnect?.(context)).catch(() => undefined);
    });
  });

  return {
    descriptor,
    handleUpgrade(request, socket, head) {
      if (requestPathname(request) !== descriptor.path) {
        return false;
      }
      if (disposed) {
        socket.destroy();
        return true;
      }
      if (clients.size >= connectionCapacity) {
        socket.destroy();
        return true;
      }
      const validated = validateWebSocketUpgrade(
        request,
        descriptor.allowedOrigins,
        descriptor.browserToken,
      );
      if (!validated) {
        socket.destroy();
        return true;
      }
      if ([...clients.values()].some((client) => client.pageClientId === validated.pageClientId)) {
        socket.destroy();
        return true;
      }
      const connectionId = randomBytes(16).toString('base64url');
      const context: WebpackBrowserClientContext = {
        pageClientId: validated.pageClientId,
        connectionId,
        remoteAddress: request.socket.remoteAddress ?? null,
        send(event, payload) {
          const activeSocket = [...clients.entries()].find(([, client]) => client === context)?.[0];
          if (activeSocket?.readyState === WebSocket.OPEN) {
            activeSocket.send(JSON.stringify({ event, payload }));
          }
        },
        isOpen() {
          const activeSocket = [...clients.entries()].find(([, client]) => client === context)?.[0];
          return activeSocket?.readyState === WebSocket.OPEN;
        },
      };
      pendingContexts.set(request, context);
      server.handleUpgrade(request, socket, head, (webSocket) => {
        if (disposed) {
          webSocket.terminate();
          return;
        }
        server.emit('connection', webSocket, request);
      });
      return true;
    },
    broadcast(event, payload) {
      if (disposed) {
        return;
      }
      const serialized = JSON.stringify({ event, payload });
      for (const socket of clients.keys()) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(serialized);
        }
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearInterval(heartbeat);
      const activeClients = [...clients.entries()];
      clients.clear();
      for (const [socket, context] of activeClients) {
        socket.removeAllListeners('message');
        socket.terminate();
        void Promise.resolve(options.browserMessageHandler?.onDisconnect?.(context)).catch(
          () => undefined,
        );
      }
      server.close();
      server.removeAllListeners();
    },
  };
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正安全整数`);
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
