import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { BROWSER_EVENTS, BROWSER_TOKEN_AUDIENCE, PROTOCOL_VERSION } from '@web-source-inspector/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';

import { webSourceInspector } from './index.js';
import { VIRTUAL_CLIENT_ID } from './client-module.js';

const coreMocks = vi.hoisted(() => ({
  snapshotCalls: vi.fn(),
  snapshot: undefined as unknown,
  createLoopbackBridge: vi.fn(),
}));

vi.mock('@web-source-inspector/dev-session-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web-source-inspector/dev-session-core')>();
  return {
    ...actual,
    createBrowserAddressSnapshot(options?: Parameters<typeof actual.createBrowserAddressSnapshot>[0]) {
      coreMocks.snapshotCalls(options);
      if (coreMocks.snapshot !== undefined) {
        return coreMocks.snapshot as ReturnType<typeof actual.createBrowserAddressSnapshot>;
      }
      return actual.createBrowserAddressSnapshot(options);
    },
    createLoopbackBridge: coreMocks.createLoopbackBridge,
  };
});

interface CallablePlugin {
  configResolved(config: ResolvedConfig): void;
  configureServer(server: ViteDevServer): void | Promise<void>;
  resolveId(id: string): string | null;
  load(id: string): string | null;
  transformIndexHtml(): unknown[];
  transform(source: string, moduleId: string): unknown;
}

interface FakeServer {
  server: ViteDevServer;
  hotHandlers: Map<string, (payload: unknown, client: unknown) => void>;
  watcher: EventEmitter;
  httpServer: EventEmitter & {
    listening: boolean;
    address(): unknown;
  };
}

const fixtureFile = fileURLToPath(
  new URL('../../../fixtures/vue-vite-basic/src/App.vue', import.meta.url),
);
const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));

const compiler = {
  family: 'vue3' as const,
  version: 'test',
  parseSfc(source: string) {
    const openingEnd = source.indexOf('>') + 1;
    const closingStart = source.lastIndexOf('</template>');
    return {
      template: {
        content: source.slice(openingEnd, closingStart),
        startOffset: openingEnd,
        endOffset: closingStart,
      },
      errors: [],
    };
  },
  parseTemplate(source: string) {
    const startOffset = source.indexOf('<main');
    const endOffset = source.indexOf('/>', startOffset) + 2;
    return {
      children: [{
        type: 'element' as const,
        tagName: 'main',
        sourceKind: 'element' as const,
        markerKind: 'element' as const,
        controlFlowKind: null,
        reservedAttributeNames: [],
        startOffset,
        endOffset,
        children: [],
      }],
      errors: [],
    };
  },
};

function resolvedConfig(
  command: 'serve' | 'build',
  isPreview = false,
  serverOptions: {
    host?: string | boolean;
    port?: number;
    https?: boolean;
    origin?: string;
  } = {},
): ResolvedConfig {
  return {
    root: workspaceRoot,
    base: '/',
    command,
    isPreview,
    server: {
      host: serverOptions.host,
      port: serverOptions.port ?? 5173,
      https: serverOptions.https ?? false,
      origin: serverOptions.origin ?? 'http://127.0.0.1:5173',
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as ResolvedConfig;
}

function createFakeServer(listenerPort = 5173): FakeServer {
  const hotHandlers = new Map<string, (payload: unknown, client: unknown) => void>();
  const watcher = new EventEmitter();
  const httpServer = Object.assign(new EventEmitter(), {
    listening: true,
    address: () => ({ address: '0.0.0.0', family: 'IPv4', port: listenerPort }),
  });
  const server = {
    resolvedUrls: {
      local: ['http://127.0.0.1:5173/'],
      network: [],
    },
    ws: {
      on(event: string, listener: (payload: unknown, client: unknown) => void) {
        hotHandlers.set(event, listener);
      },
      off(event: string, listener: (payload: unknown, client: unknown) => void) {
        if (hotHandlers.get(event) === listener) {
          hotHandlers.delete(event);
        }
      },
    },
    watcher,
    httpServer,
  } as unknown as ViteDevServer;
  return { server, hotHandlers, watcher, httpServer };
}

function pluginAt(plugins: Plugin[], index: number): CallablePlugin {
  return plugins[index] as unknown as CallablePlugin;
}

function readSessionContext(clientModule: string): { sessionId: string; browserToken: string } {
  const sessionId = /"sessionId":"([^"]+)"/.exec(clientModule)?.[1];
  const browserToken = /"browserToken":"([^"]+)"/.exec(clientModule)?.[1];
  if (!sessionId || !browserToken) {
    throw new Error('虚拟客户端缺少 session 上下文');
  }
  return { sessionId, browserToken };
}

function createBrowserClient(remoteAddress: string, sent: Array<[string, unknown]>) {
  return {
    socket: { _socket: { remoteAddress } },
    send(event: string, payload: unknown) {
      sent.push([event, payload]);
    },
  };
}

afterEach(() => {
  coreMocks.snapshotCalls.mockClear();
  coreMocks.snapshot = undefined;
  coreMocks.createLoopbackBridge.mockReset();
});

describe('Vite adapter lifecycle', () => {
  it.each([
    ['build', false],
    ['serve', true],
  ] as const)('%s/preview 生命周期完全 no-op', async (command, isPreview) => {
    const plugins = webSourceInspector({ compiler, bridge: false });
    const prePlugin = pluginAt(plugins, 0);
    const fakeServer = createFakeServer();

    expect(prePlugin.resolveId(VIRTUAL_CLIENT_ID)).toBeNull();
    prePlugin.configResolved(resolvedConfig(command, isPreview));
    await prePlugin.configureServer(fakeServer.server);

    expect(fakeServer.hotHandlers.size).toBe(0);
    expect(prePlugin.transformIndexHtml()).toEqual([]);
    expect(await prePlugin.transform('<template><main /></template>', fixtureFile)).toBeNull();
    expect(coreMocks.snapshotCalls).not.toHaveBeenCalled();
  });

  it('same-machine 使用启动快照和实际端口注册本机网卡浏览器', async () => {
    coreMocks.snapshot = Object.freeze({
      addresses: Object.freeze(['192.0.2.20']),
    });
    const plugins = webSourceInspector({
      browserAccess: 'same-machine',
      compiler,
      bridge: false,
    });
    const prePlugin = pluginAt(plugins, 0);
    const fakeServer = createFakeServer(4312);
    prePlugin.configResolved(resolvedConfig('serve', false, {
      host: true,
      port: 3002,
    }));
    await prePlugin.configureServer(fakeServer.server);

    const clientModule = prePlugin.load(prePlugin.resolveId(VIRTUAL_CLIENT_ID) ?? '');
    const session = readSessionContext(clientModule ?? '');
    const sent: Array<[string, unknown]> = [];
    const client = createBrowserClient('192.0.2.20', sent);

    fakeServer.hotHandlers.get(BROWSER_EVENTS.hello)?.({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      pageClientId: 'page_client_same_machine',
      timestamp: Date.now(),
      browserToken: session.browserToken,
      tokenAudience: BROWSER_TOKEN_AUDIENCE,
      runtimeVersion: '0.1.0',
      capabilities: [],
      page: {
        origin: 'http://192.0.2.20:4312',
        pathname: '/',
        title: 'Fixture',
      },
    }, client);

    expect(coreMocks.snapshotCalls).toHaveBeenCalledOnce();
    expect(sent).toContainEqual([
      BROWSER_EVENTS.connection,
      expect.not.objectContaining({ message: '当前浏览器地址未授权' }),
    ]);
    fakeServer.httpServer.emit('close');
  });

  it('同机模式 listener 不可用时保持 Router fail closed 且不启动 Bridge', async () => {
    coreMocks.snapshot = Object.freeze({
      addresses: Object.freeze(['192.0.2.20']),
    });
    const plugins = webSourceInspector({
      browserAccess: 'same-machine',
      compiler,
      bridge: true,
    });
    const prePlugin = pluginAt(plugins, 0);
    const fakeServer = createFakeServer(4312);
    fakeServer.server.httpServer = null;
    prePlugin.configResolved(resolvedConfig('serve', false, { host: true }));
    await prePlugin.configureServer(fakeServer.server);

    const clientModule = prePlugin.load(prePlugin.resolveId(VIRTUAL_CLIENT_ID) ?? '');
    const session = readSessionContext(clientModule ?? '');
    const sent: Array<[string, unknown]> = [];
    const client = createBrowserClient('192.0.2.20', sent);
    fakeServer.hotHandlers.get(BROWSER_EVENTS.hello)?.({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      pageClientId: 'page_client_listener_missing',
      timestamp: Date.now(),
      browserToken: session.browserToken,
      tokenAudience: BROWSER_TOKEN_AUDIENCE,
      runtimeVersion: '0.1.0',
      capabilities: [],
      page: {
        origin: 'http://192.0.2.20:4312',
        pathname: '/',
        title: 'Fixture',
      },
    }, client);

    expect(coreMocks.createLoopbackBridge).not.toHaveBeenCalled();
    expect(sent).toContainEqual([
      BROWSER_EVENTS.connection,
      expect.objectContaining({ message: '当前浏览器地址未授权' }),
    ]);
    fakeServer.watcher.emit('close');
  });

  it('Bridge descriptor 与 Router 复用同一组冻结 Origin', async () => {
    coreMocks.snapshot = Object.freeze({
      addresses: Object.freeze(['192.0.2.20']),
    });
    const bridge = {
      requestOpenSource: vi.fn(),
      notifyTabsChanged: vi.fn(),
      dispose: vi.fn(),
    };
    coreMocks.createLoopbackBridge.mockResolvedValue(bridge);
    const plugins = webSourceInspector({
      browserAccess: 'same-machine',
      compiler,
    });
    const prePlugin = pluginAt(plugins, 0);
    const fakeServer = createFakeServer(4312);
    prePlugin.configResolved(resolvedConfig('serve', false, { host: true, port: 3002 }));
    await prePlugin.configureServer(fakeServer.server);
    await Promise.resolve();

    expect(coreMocks.createLoopbackBridge).toHaveBeenCalledOnce();
    const bridgeOptions = coreMocks.createLoopbackBridge.mock.calls[0]?.[0] as {
      session: { devOrigins: readonly string[] };
      getBrowserTabs(): unknown[];
    };
    expect(Object.isFrozen(bridgeOptions.session.devOrigins)).toBe(true);
    expect(bridgeOptions.session.devOrigins).toContain('http://192.0.2.20:4312');

    const clientModule = prePlugin.load(prePlugin.resolveId(VIRTUAL_CLIENT_ID) ?? '');
    const session = readSessionContext(clientModule ?? '');
    const sent: Array<[string, unknown]> = [];
    const client = createBrowserClient('192.0.2.20', sent);
    fakeServer.hotHandlers.get(BROWSER_EVENTS.hello)?.({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      pageClientId: 'page_client_descriptor_origin',
      timestamp: Date.now(),
      browserToken: session.browserToken,
      tokenAudience: BROWSER_TOKEN_AUDIENCE,
      runtimeVersion: '0.1.0',
      capabilities: [],
      page: {
        origin: 'http://192.0.2.20:4312',
        pathname: '/',
        title: 'Fixture',
      },
    }, client);

    expect(bridgeOptions.getBrowserTabs()).toHaveLength(1);
    expect(bridge.notifyTabsChanged).toHaveBeenCalled();
    fakeServer.httpServer.emit('close');
  });

  it('只在 post transform 成功后提交 staged SourceRecord', async () => {
    const plugins = webSourceInspector({ compiler, bridge: false });
    const prePlugin = pluginAt(plugins, 0);
    const commitPlugin = pluginAt(plugins, 1);
    const fakeServer = createFakeServer();
    prePlugin.configResolved(resolvedConfig('serve'));
    await prePlugin.configureServer(fakeServer.server);

    const clientId = prePlugin.resolveId(VIRTUAL_CLIENT_ID);
    expect(clientId).toBeTypeOf('string');
    const clientModule = prePlugin.load(clientId ?? '');
    expect(clientModule).toBeTypeOf('string');
    expect(clientModule).not.toContain('relativePath');
    const session = readSessionContext(clientModule ?? '');
    const source = '<template><main /></template>';
    const transformed = await prePlugin.transform(source, fixtureFile) as {
      code: string;
    };
    const sourceId = /data-wsi-source="([A-Za-z0-9_-]+)"/.exec(transformed.code)?.[1];
    expect(sourceId).toHaveLength(43);

    const sent: Array<[string, unknown]> = [];
    const client = {
      socket: { _socket: { remoteAddress: '127.0.0.1' } },
      send(event: string, payload: unknown) {
        sent.push([event, payload]);
      },
    };
    const pageClientId = 'page_client_lifecycle';
    const browserContext = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      pageClientId,
      timestamp: Date.now(),
      browserToken: session.browserToken,
      tokenAudience: BROWSER_TOKEN_AUDIENCE,
    };
    fakeServer.hotHandlers.get(BROWSER_EVENTS.hello)?.({
      ...browserContext,
      runtimeVersion: '0.1.0',
      capabilities: [],
      page: {
        origin: 'http://127.0.0.1:5173',
        pathname: '/',
        title: 'Fixture',
      },
    }, client);
    const requestMetadata = (): void => {
      fakeServer.hotHandlers.get(BROWSER_EVENTS.metadataRequest)?.({
        ...browserContext,
        timestamp: Date.now(),
        sourceId,
      }, client);
    };

    requestMetadata();
    expect(sent.some(([event]) => event === BROWSER_EVENTS.metadata)).toBe(false);

    await commitPlugin.transform('', fixtureFile);
    requestMetadata();
    expect(sent).toContainEqual([
      BROWSER_EVENTS.metadata,
      expect.objectContaining({ sourceId, tagName: 'main' }),
    ]);

    fakeServer.httpServer.emit('close');
    expect(fakeServer.hotHandlers.size).toBe(0);
  });
});
