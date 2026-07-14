import {
  createBrowserAddressPolicy,
  isLoopbackAddress,
  normalizeBrowserAddress,
  type BrowserAccessMode,
  type BrowserAddressPolicy,
  type BrowserAddressSnapshot,
} from '@web-source-inspector/dev-session-core';
import { PROTOCOL_LIMITS } from '@web-source-inspector/protocol';
import type { ResolvedConfig, ViteDevServer } from 'vite';

const EMPTY_ALLOWED_ORIGINS: readonly string[] = Object.freeze([]);

export interface ResolvedViteBrowserAccessContext {
  readonly browserAddressPolicy: BrowserAddressPolicy;
  readonly allowedOrigins: readonly string[];
  readonly actualPort: number | null;
  readonly protocol: 'http:' | 'https:';
}

export interface ResolveViteBrowserAccessContextOptions {
  readonly browserAccess: BrowserAccessMode;
  readonly server: ViteDevServer;
  readonly config: ResolvedConfig;
  readonly browserAddressSnapshot: BrowserAddressSnapshot;
  /** Router 在监听前已持有该策略，必须复用同一快照。 */
  readonly browserAddressPolicy?: BrowserAddressPolicy;
  readonly diagnostics?: (message: string) => void;
}

function resolveProtocol(config: ResolvedConfig): 'http:' | 'https:' {
  return config.server.https ? 'https:' : 'http:';
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function portFromUrl(url: URL): number {
  if (url.port.length > 0) {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 1
    && value <= 65_535;
}

function readActualListenerPort(server: ViteDevServer): number | null {
  const httpServer = server.httpServer;
  if (!httpServer || typeof httpServer.address !== 'function') {
    return null;
  }
  try {
    const address = httpServer.address();
    if (!address || typeof address === 'string' || !isValidPort(address.port)) {
      return null;
    }
    return address.port;
  } catch {
    return null;
  }
}

function originForAddress(protocol: 'http:' | 'https:', address: string, port: number): string {
  const host = address.includes(':') ? `[${address}]` : address;
  return new URL(`${protocol}//${host}:${port}`).origin;
}

function isWildcardHost(host: unknown): boolean {
  return host === true || host === '0.0.0.0' || host === '::';
}

function resolveSameMachineAddresses(
  host: unknown,
  snapshot: BrowserAddressSnapshot,
): readonly string[] | null {
  if (isWildcardHost(host)) {
    return snapshot.addresses.filter((address) => !isLoopbackAddress(address));
  }
  if (typeof host !== 'string') {
    return null;
  }
  const normalizedHost = normalizeBrowserAddress(host);
  if (!normalizedHost || isLoopbackAddress(normalizedHost)) {
    return null;
  }
  return snapshot.addresses.includes(normalizedHost) ? [normalizedHost] : null;
}

function addLoopbackOrigins(
  origins: Set<string>,
  protocol: 'http:' | 'https:',
  port: number,
): void {
  origins.add(originForAddress(protocol, '127.0.0.1', port));
  origins.add(originForAddress(protocol, 'localhost', port));
  origins.add(originForAddress(protocol, '::1', port));
}

function addLoopbackCompatibilityOrigins(
  origins: Set<string>,
  server: ViteDevServer,
  config: ResolvedConfig,
  protocol: 'http:' | 'https:',
  port: number,
): void {
  const candidates = [
    ...(server.resolvedUrls?.local ?? []),
    ...(server.resolvedUrls?.network ?? []),
    ...(typeof config.server.origin === 'string' ? [config.server.origin] : []),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeOrigin(candidate);
    if (!normalized) {
      continue;
    }
    const url = new URL(normalized);
    if (url.protocol === protocol && portFromUrl(url) === port) {
      origins.add(normalized);
    }
  }
}

function freezeOrigins(origins: Iterable<string>): readonly string[] {
  const normalized = new Set<string>();
  for (const origin of origins) {
    const value = normalizeOrigin(origin);
    if (value) {
      normalized.add(value);
    }
  }
  const values = [...normalized].sort();
  if (values.length > PROTOCOL_LIMITS.originCount) {
    throw new Error('BROWSER_ORIGIN_LIMIT_EXCEEDED');
  }
  return Object.freeze(values);
}

/**
 * 将 Vite listener、host 和启动快照收敛为一次性的 Browser 地址策略。
 */
export function resolveViteBrowserAccessContext(
  options: ResolveViteBrowserAccessContextOptions,
): ResolvedViteBrowserAccessContext {
  const protocol = resolveProtocol(options.config);
  const browserAddressPolicy = options.browserAddressPolicy
    ?? createBrowserAddressPolicy({
      mode: options.browserAccess,
      snapshot: options.browserAddressSnapshot,
    });
  const actualListenerPort = readActualListenerPort(options.server);

  if (options.browserAccess === 'same-machine' && actualListenerPort === null) {
    options.diagnostics?.('BROWSER_LISTENER_UNAVAILABLE');
    return {
      browserAddressPolicy,
      allowedOrigins: EMPTY_ALLOWED_ORIGINS,
      actualPort: null,
      protocol,
    };
  }

  // loopback 兼容中间件服务器；同机模式绝不以配置端口猜测 listener。
  const originPort = actualListenerPort ?? options.config.server.port ?? 5173;
  const origins = new Set<string>();
  addLoopbackOrigins(origins, protocol, originPort);

  if (options.browserAccess === 'same-machine') {
    const addresses = resolveSameMachineAddresses(
      options.config.server.host,
      options.browserAddressSnapshot,
    );
    if (addresses === null) {
      options.diagnostics?.('BROWSER_SAME_MACHINE_HOST_UNAVAILABLE');
    } else {
      for (const address of addresses) {
        origins.add(originForAddress(protocol, address, originPort));
      }
    }

    // config.server.origin 不能扩大集合；仅保留已证明等价的字面量 Origin。
    const configuredOrigin = typeof options.config.server.origin === 'string'
      ? normalizeOrigin(options.config.server.origin)
      : null;
    if (configuredOrigin && origins.has(configuredOrigin)) {
      origins.add(configuredOrigin);
    }
  } else {
    addLoopbackCompatibilityOrigins(origins, options.server, options.config, protocol, originPort);
  }

  return {
    browserAddressPolicy,
    allowedOrigins: freezeOrigins(origins),
    actualPort: actualListenerPort,
    protocol,
  };
}
