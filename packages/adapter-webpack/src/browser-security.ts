import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { isLoopbackAddress } from '@web-source-inspector/dev-session-core';

import { WebpackAdapterError } from './errors.js';

const SAFE_CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ValidatedBrowserRequest {
  origin: string;
  pageClientId: string;
  connectionId: string;
}

export function normalizeAllowedOrigins(origins: readonly string[]): string[] {
  if (origins.length === 0) {
    throw new WebpackAdapterError(
      'INVALID_BROWSER_TRANSPORT_CONFIG',
      'Browser Transport 至少需要一个精确 allowedOrigins',
    );
  }

  const normalized = new Set<string>();
  for (const origin of origins) {
    if (origin === '*' || origin === 'null') {
      throwInvalidOrigin(origin);
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throwInvalidOrigin(origin);
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.origin !== origin
    ) {
      throwInvalidOrigin(origin);
    }
    normalized.add(parsed.origin);
  }
  return [...normalized];
}

export function validateBrowserHttpRequest(
  request: IncomingMessage,
  allowedOrigins: readonly string[] | null,
  expectedToken: string,
): ValidatedBrowserRequest | null {
  const remoteAddress = request.socket.remoteAddress;
  if (!isLoopbackAddress(remoteAddress)) {
    return null;
  }
  const origin = singleHeader(request, 'origin');
  const host = singleHeader(request, 'host');
  const authorization = singleHeader(request, 'authorization');
  const pageClientId = singleHeader(request, 'x-wsi-page-client-id');
  const connectionId = singleHeader(request, 'x-wsi-connection-id');
  if (
    origin === null ||
    host === null ||
    authorization === null ||
    pageClientId === null ||
    connectionId === null ||
    !SAFE_CLIENT_ID_PATTERN.test(pageClientId) ||
    !SAFE_CLIENT_ID_PATTERN.test(connectionId)
  ) {
    return null;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return null;
  }
  const protocol = isEncryptedRequest(request) ? 'https:' : 'http:';
  if (
    parsedOrigin.origin !== origin ||
    parsedOrigin.protocol !== protocol ||
    parsedOrigin.host.toLowerCase() !== host.toLowerCase() ||
    (allowedOrigins !== null && !allowedOrigins.includes(parsedOrigin.origin)) ||
    !constantTimeEqual(authorization, `Bearer ${expectedToken}`)
  ) {
    return null;
  }
  return { origin, pageClientId, connectionId };
}

export function validateWebSocketUpgrade(
  request: IncomingMessage,
  allowedOrigins: readonly string[],
  expectedToken: string,
): Omit<ValidatedBrowserRequest, 'connectionId'> | null {
  const remoteAddress = request.socket.remoteAddress;
  const origin = singleHeader(request, 'origin');
  const host = singleHeader(request, 'host');
  const protocols = singleHeader(request, 'sec-websocket-protocol');
  const pageClientId = getSearchParameter(request.url, 'pageClientId');
  if (
    !isLoopbackAddress(remoteAddress) ||
    origin === null ||
    host === null ||
    protocols === null ||
    pageClientId === null ||
    !SAFE_CLIENT_ID_PATTERN.test(pageClientId)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  const offeredProtocols = protocols.split(',').map((value) => value.trim());
  if (
    parsed.origin !== origin ||
    !isLoopbackHost(host) ||
    !allowedOrigins.includes(parsed.origin) ||
    !offeredProtocols.includes('wsi-browser-v1') ||
    !offeredProtocols.some((value) => constantTimeEqual(value, `wsi-token.${expectedToken}`))
  ) {
    return null;
  }
  return { origin, pageClientId };
}

function isLoopbackHost(host: string): boolean {
  try {
    const parsed = new URL(`http://${host}`);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.');
  } catch {
    return false;
  }
}

export function requestPathname(request: IncomingMessage): string | null {
  if (!request.url?.startsWith('/')) {
    return null;
  }
  try {
    return new URL(request.url, 'http://wsi.invalid').pathname;
  } catch {
    return null;
  }
}

export function isBodyLengthAllowed(
  request: IncomingMessage,
  maximumBytes: number,
): boolean {
  const contentLength = singleHeader(request, 'content-length');
  if (contentLength === null) {
    return true;
  }
  if (!/^(0|[1-9]\d*)$/.test(contentLength)) {
    return false;
  }
  return Number(contentLength) <= maximumBytes;
}

export function singleHeader(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

function isEncryptedRequest(request: IncomingMessage): boolean {
  return Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted);
}

function getSearchParameter(url: string | undefined, name: string): string | null {
  if (!url?.startsWith('/')) {
    return null;
  }
  try {
    const values = new URL(url, 'http://wsi.invalid').searchParams.getAll(name);
    return values.length === 1 ? values[0] ?? null : null;
  } catch {
    return null;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function throwInvalidOrigin(origin: string): never {
  throw new WebpackAdapterError(
    'INVALID_BROWSER_TRANSPORT_CONFIG',
    `allowedOrigins 必须是精确 HTTP(S) origin：${origin}`,
  );
}
