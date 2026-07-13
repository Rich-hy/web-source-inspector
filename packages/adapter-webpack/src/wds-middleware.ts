import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  DEFAULT_BROWSER_CONNECTION_CAPACITY,
  DEFAULT_BROWSER_HEARTBEAT_MS,
  DEFAULT_BROWSER_MESSAGE_BYTES,
} from './constants.js';
import {
  isBodyLengthAllowed,
  requestPathname,
  validateBrowserHttpRequest,
} from './browser-security.js';
import { getWebpackAdapterSession } from './registry.js';
import { ensureWebpackBridge } from './browser-session.js';
import type {
  ConnectMiddleware,
  WebpackAdapterSession,
  WebpackBrowserClientContext,
  WebpackCompilerLike,
} from './types.js';

interface ActiveStream {
  client: WebpackBrowserClientContext;
  response: ServerResponse;
}

export function createWebSourceInspectorBrowserMiddleware(
  compiler: WebpackCompilerLike,
): ConnectMiddleware | null {
  const session = getWebpackAdapterSession(compiler);
  if (!session || session.disposed || !session.wdsCredential) {
    return null;
  }
  if (session.middleware) {
    return session.middleware;
  }
  const credential = session.wdsCredential;
  ensureWebpackBridge(session);

  const activeStreams = new Map<string, ActiveStream>();
  const heartbeat = setInterval(() => {
    broadcast(activeStreams, '__wsi:transport:heartbeat', { timestamp: Date.now() });
  }, DEFAULT_BROWSER_HEARTBEAT_MS);
  heartbeat.unref?.();

  const middleware: ConnectMiddleware = (request, response, next) => {
    const pathname = requestPathname(request);
    const streamPath = `${credential.basePath}/stream/open`;
    const messagePath = `${credential.basePath}/message`;
    if (pathname !== streamPath && pathname !== messagePath) {
      next();
      return;
    }
    if (!isActiveSession(compiler, session, credential)) {
      respond(response, 410, 'SESSION_REVOKED');
      return;
    }
    if (request.method !== 'POST') {
      respond(response, 405, 'METHOD_NOT_ALLOWED', { Allow: 'POST' });
      return;
    }

    // 在监听 body 之前完成 loopback、Origin/Host/协议和 token 校验。
    const validated = validateBrowserHttpRequest(
      request,
      credential.allowedOrigins,
      credential.browserToken,
    );
    if (!validated) {
      respond(response, 401, 'AUTH_FAILED');
      return;
    }
    credential.observedOrigins.add(validated.origin);
    if (!isBodyLengthAllowed(request, DEFAULT_BROWSER_MESSAGE_BYTES)) {
      respond(response, 413, 'MESSAGE_TOO_LARGE');
      return;
    }

    if (pathname === streamPath) {
      if (
        (typeof request.headers['content-length'] === 'string' &&
          request.headers['content-length'] !== '0') ||
        request.headers['transfer-encoding'] !== undefined
      ) {
        respond(response, 400, 'STREAM_OPEN_BODY_UNSUPPORTED');
        return;
      }
      openStream(session, activeStreams, request, response, validated.pageClientId, validated.connectionId);
      return;
    }
    void receiveMessage(
      session,
      activeStreams,
      request,
      response,
      validated.pageClientId,
      validated.connectionId,
    );
  };

  session.middleware = middleware;
  session.disposeMiddleware = () => {
    clearInterval(heartbeat);
    for (const stream of activeStreams.values()) {
      if (!stream.response.writableEnded) {
        stream.response.end();
      }
    }
    activeStreams.clear();
  };
  return middleware;
}

export function getWebSourceInspectorBrowserTransportDescriptor(
  compiler: WebpackCompilerLike,
): { basePath: string; browserToken: string } | null {
  const credential = getWebpackAdapterSession(compiler)?.wdsCredential;
  return credential
    ? { basePath: credential.basePath, browserToken: credential.browserToken }
    : null;
}

function openStream(
  session: WebpackAdapterSession,
  activeStreams: Map<string, ActiveStream>,
  request: IncomingMessage,
  response: ServerResponse,
  pageClientId: string,
  connectionId: string,
): void {
  if (
    activeStreams.size >= DEFAULT_BROWSER_CONNECTION_CAPACITY ||
    activeStreams.has(connectionId) ||
    [...activeStreams.values()].some((stream) => stream.client.pageClientId === pageClientId)
  ) {
    respond(response, 409, 'CLIENT_ALREADY_CONNECTED');
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  setNoStoreHeaders(response);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.flushHeaders?.();

  let closed = false;
  const client: WebpackBrowserClientContext = {
    pageClientId,
    connectionId,
    remoteAddress: request.socket.remoteAddress ?? null,
    send(event, payload) {
      if (!response.writableEnded) {
        response.write(`${JSON.stringify({ event, payload })}\n`);
      }
    },
    isOpen() {
      return !closed && !response.writableEnded;
    },
  };
  activeStreams.set(connectionId, { client, response });
  void Promise.resolve(session.browserMessageHandler?.onConnect?.(client)).catch(() => {
    response.end();
  });

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    activeStreams.delete(connectionId);
    void Promise.resolve(session.browserMessageHandler?.onDisconnect?.(client)).catch(() => undefined);
  };
  response.once('close', close);
}

async function receiveMessage(
  session: WebpackAdapterSession,
  activeStreams: ReadonlyMap<string, ActiveStream>,
  request: IncomingMessage,
  response: ServerResponse,
  pageClientId: string,
  connectionId: string,
): Promise<void> {
  const stream = activeStreams.get(connectionId);
  if (!stream || stream.client.pageClientId !== pageClientId) {
    respond(response, 409, 'CLIENT_NOT_REGISTERED');
    return;
  }
  try {
    const body = await readJsonBody(request, DEFAULT_BROWSER_MESSAGE_BYTES);
    if (session.disposed) {
      respond(response, 410, 'SESSION_REVOKED');
      return;
    }
    await session.browserMessageHandler?.onMessage?.(body, stream.client);
    response.statusCode = 204;
    setNoStoreHeaders(response);
    response.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'INVALID_MESSAGE';
    respond(response, message === 'MESSAGE_TOO_LARGE' ? 413 : 400, message);
  }
}

function isActiveSession(
  compiler: WebpackCompilerLike,
  session: WebpackAdapterSession,
  credential: NonNullable<WebpackAdapterSession['wdsCredential']>,
): boolean {
  return (
    !session.disposed &&
    session.wdsCredential === credential &&
    getWebpackAdapterSession(compiler) === session
  );
}

function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > maximumBytes) {
        reject(new Error('MESSAGE_TOO_LARGE'));
        return;
      }
      chunks.push(buffer);
    });
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new Error('INVALID_MESSAGE'));
      }
    });
    request.once('error', reject);
  });
}

function broadcast(
  activeStreams: ReadonlyMap<string, ActiveStream>,
  event: string,
  payload: unknown,
): void {
  for (const stream of activeStreams.values()) {
    stream.client.send(event, payload);
  }
}

function respond(
  response: ServerResponse,
  statusCode: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  response.statusCode = statusCode;
  setNoStoreHeaders(response);
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
  response.end(message);
}

function setNoStoreHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
}
