import {
  createBrowserAddressSnapshot,
  type BrowserAccessMode,
} from '@web-source-inspector/dev-session-core';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig, ViteDevServer } from 'vite';

import { resolveViteBrowserAccessContext } from './browser-access';
import { resolveInspectorOptions, type WebSourceInspectorOptions } from './types';

interface ContextOptions {
  readonly browserAccess?: BrowserAccessMode;
  readonly host?: string | boolean;
  readonly port?: number;
  readonly https?: boolean;
  readonly listenerAddress?: unknown;
  readonly snapshotAddresses?: readonly string[];
  readonly resolvedUrls?: { readonly local?: readonly string[]; readonly network?: readonly string[] };
  readonly origin?: string;
  readonly diagnostics?: (message: string) => void;
}

function createConfig(options: ContextOptions): ResolvedConfig {
  return {
    server: {
      host: options.host,
      port: options.port ?? 3002,
      https: options.https ?? false,
      origin: options.origin,
    },
  } as unknown as ResolvedConfig;
}

function createServer(options: ContextOptions): ViteDevServer {
  const listenerAddress = options.listenerAddress === undefined
    ? { address: '0.0.0.0', family: 'IPv4', port: 4312 }
    : options.listenerAddress;
  return {
    httpServer: listenerAddress === null
      ? null
      : { address: () => listenerAddress },
    resolvedUrls: options.resolvedUrls,
  } as unknown as ViteDevServer;
}

function resolveContext(options: ContextOptions = {}) {
  const browserAddressSnapshot = createBrowserAddressSnapshot({
    addresses: options.snapshotAddresses ?? ['192.0.2.20'],
  });
  return resolveViteBrowserAccessContext({
    browserAccess: options.browserAccess ?? 'same-machine',
    server: createServer(options),
    config: createConfig(options),
    browserAddressSnapshot,
    diagnostics: options.diagnostics,
  });
}

describe('resolveViteBrowserAccessContext', () => {
  it('只使用实际 listener 端口，不回退到配置端口', () => {
    const context = resolveContext({
      host: true,
      port: 3002,
      listenerAddress: { address: '0.0.0.0', family: 'IPv4', port: 4312 },
      snapshotAddresses: ['192.0.2.20'],
    });

    expect(context.actualPort).toBe(4312);
    expect(context.allowedOrigins).toContain('http://192.0.2.20:4312');
    expect(context.allowedOrigins).not.toContain('http://192.0.2.20:3002');
  });

  it('按 Vite HTTPS 配置生成 HTTPS Origin', () => {
    const context = resolveContext({ host: true, https: true });

    expect(context.protocol).toBe('https:');
    expect(context.allowedOrigins).toEqual(expect.arrayContaining([
      'https://127.0.0.1:4312',
      'https://localhost:4312',
      'https://[::1]:4312',
      'https://192.0.2.20:4312',
    ]));
  });

  it.each([true, '0.0.0.0', '::'] as const)(
    'wildcard host=%p 只加入启动快照中的所有非回环地址',
    (host) => {
      const context = resolveContext({
        host,
        snapshotAddresses: ['127.0.0.1', '198.51.100.2', '192.0.2.20'],
      });

      expect(context.allowedOrigins).toEqual(expect.arrayContaining([
        'http://192.0.2.20:4312',
        'http://198.51.100.2:4312',
      ]));
      expect(context.allowedOrigins.filter((origin) => origin.includes('127.0.0.1'))).toHaveLength(1);
    },
  );

  it('精确 IP host 只加入对应的快照地址', () => {
    const context = resolveContext({
      host: '198.51.100.2',
      snapshotAddresses: ['198.51.100.2', '192.0.2.20'],
    });

    expect(context.allowedOrigins).toContain('http://198.51.100.2:4312');
    expect(context.allowedOrigins).not.toContain('http://192.0.2.20:4312');
  });

  it.each([false, undefined, 'localhost', '127.0.0.1', 'dev.example.test'] as const)(
    '不为 host=%p 推断网卡地址',
    (host) => {
      const diagnostics = vi.fn();
      const context = resolveContext({
        host,
        snapshotAddresses: ['192.0.2.20'],
        diagnostics,
      });

      expect(context.allowedOrigins).not.toContain('http://192.0.2.20:4312');
      expect(diagnostics).toHaveBeenCalledWith('BROWSER_SAME_MACHINE_HOST_UNAVAILABLE');
    },
  );

  it('为 IPv6 网卡地址生成带方括号的 Origin', () => {
    const context = resolveContext({
      host: '::',
      snapshotAddresses: ['2001:db8::20'],
    });

    expect(context.allowedOrigins).toContain('http://[2001:db8::20]:4312');
  });

  it('冻结、去重并稳定排序 Origin', () => {
    const context = resolveContext({
      host: true,
      snapshotAddresses: ['198.51.100.2', '192.0.2.20', '198.51.100.2'],
    });

    expect(Object.isFrozen(context.allowedOrigins)).toBe(true);
    expect(context.allowedOrigins).toEqual([...context.allowedOrigins].sort());
    expect(context.allowedOrigins).toContain('http://198.51.100.2:4312');
  });

  it('不会通过 config.server.origin 扩大同机地址集合', () => {
    const context = resolveContext({
      host: true,
      origin: 'http://203.0.113.1:4312',
      snapshotAddresses: ['192.0.2.20'],
    });

    expect(context.allowedOrigins).not.toContain('http://203.0.113.1:4312');
  });

  it('超过协议 Origin 上限时明确失败', () => {
    const snapshotAddresses = Array.from(
      { length: 30 },
      (_, index) => `192.0.2.${index + 1}`,
    );

    expect(() => resolveContext({ host: true, snapshotAddresses }))
      .toThrow('BROWSER_ORIGIN_LIMIT_EXCEEDED');
  });

  it.each([
    ['缺少 HTTP server', null],
    ['Unix socket listener', 'C:\\tmp\\vite.sock'],
  ])('同机模式在%s时 fail closed', (_label, listenerAddress) => {
    const diagnostics = vi.fn();
    const context = resolveContext({
      host: true,
      listenerAddress,
      diagnostics,
    });

    expect(context.actualPort).toBeNull();
    expect(context.allowedOrigins).toEqual([]);
    expect(diagnostics).toHaveBeenCalledWith('BROWSER_LISTENER_UNAVAILABLE');
  });

  it('loopback middleware 保留配置端口回退但不伪造实际端口', () => {
    const context = resolveContext({
      browserAccess: 'loopback',
      listenerAddress: null,
      port: 3002,
    });

    expect(context.actualPort).toBeNull();
    expect(context.allowedOrigins).toEqual(expect.arrayContaining([
      'http://127.0.0.1:3002',
      'http://localhost:3002',
      'http://[::1]:3002',
    ]));
  });

  it('复用调用方创建的一次性快照，不重新读取网卡', () => {
    const networkInterfaces = vi.fn(() => ({
      Ethernet: [{ address: '192.0.2.20' }],
    }));
    const browserAddressSnapshot = createBrowserAddressSnapshot({ networkInterfaces });
    const options = {
      browserAccess: 'same-machine' as const,
      server: createServer({ host: true }),
      config: createConfig({ host: true }),
      browserAddressSnapshot,
    };

    resolveViteBrowserAccessContext(options);
    resolveViteBrowserAccessContext(options);

    expect(networkInterfaces).toHaveBeenCalledOnce();
  });
});

describe('resolveInspectorOptions', () => {
  it('默认 BrowserAccess 为 same-machine，且可显式收紧为 loopback', () => {
    expect(resolveInspectorOptions().browserAccess).toBe('same-machine');
    expect(resolveInspectorOptions({ browserAccess: 'same-machine' }).browserAccess).toBe('same-machine');
    expect(resolveInspectorOptions({ browserAccess: 'loopback' }).browserAccess).toBe('loopback');
    expect(resolveInspectorOptions({
      browserAccess: 'same-machine',
      remoteBrowser: false,
    }).browserAccess).toBe('same-machine');
  });

  it('拒绝无效 browserAccess 和动态 remoteBrowser=true', () => {
    expect(() => resolveInspectorOptions({
      browserAccess: 'remote' as BrowserAccessMode,
    })).toThrow('INVALID_BROWSER_ACCESS');
    expect(() => resolveInspectorOptions({
      remoteBrowser: true,
    } as unknown as WebSourceInspectorOptions)).toThrow('REMOTE_BROWSER_UNSUPPORTED');
  });
});
