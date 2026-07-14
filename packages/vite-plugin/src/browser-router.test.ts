import type { SourceRecord } from '@web-source-inspector/compiler-core';
import { createBrowserAddressPolicy } from '@web-source-inspector/dev-session-core';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserRouter,
  type BrowserRouterOptions,
  type ViteBrowserClient,
} from './browser-router';
import type { LoopbackBridge } from './bridge-types';

const BROWSER_TOKEN = 'b'.repeat(43);
const TOKEN_AUDIENCE = 'browser-transport';

const record: SourceRecord = {
  sourceId: 'a'.repeat(43),
  rootKey: 'root-key',
  relativePath: 'src/App.vue',
  framework: 'vue',
  kind: 'element',
  tagName: 'button',
  range: {
    startLine: 10,
    startColumn: 3,
    endLine: 10,
    endColumn: 20,
    startOffset: 100,
    endOffset: 117
  },
  componentName: 'App',
  controlFlow: null,
  parentSourceId: null,
  sourceDigest: 'digest',
  contextBefore: '<template>',
  contextAfter: '</template>',
  moduleId: 'src/App.vue',
  generation: 1,
  accuracy: 'exact'
};

function createRouter(overrides: Partial<BrowserRouterOptions> = {}): BrowserRouter {
  return new BrowserRouter({
    sessionId: 'session_1234',
    browserToken: BROWSER_TOKEN,
    browserAddressPolicy: createBrowserAddressPolicy({ mode: 'loopback' }),
    allowedOrigins: ['http://127.0.0.1:5173'],
    resolveSource: () => ({ status: 'found', record }),
    ...overrides,
  });
}

function createClient(address = '127.0.0.1'): ViteBrowserClient & { sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    socket: { _socket: { remoteAddress: address } },
    send(event, payload) {
      sent.push([event, payload]);
    }
  };
}

type RemoteAddressPath = 'socket._socket' | 'socket' | '_socket';

function createClientForAddressPath(
  path: RemoteAddressPath,
  remoteAddress: string,
): ViteBrowserClient & { sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = [];
  const client: ViteBrowserClient & { sent: Array<[string, unknown]> } = {
    sent,
    send(event, payload) {
      sent.push([event, payload]);
    },
  };
  if (path === 'socket._socket') {
    client.socket = { _socket: { remoteAddress } };
  } else if (path === 'socket') {
    client.socket = { remoteAddress };
  } else {
    client._socket = { remoteAddress };
  }
  return client;
}

function helloPayload(pageClientId = 'page_client_1234'): Record<string, unknown> {
  return {
    protocolVersion: '1.0',
    sessionId: 'session_1234',
    browserToken: BROWSER_TOKEN,
    tokenAudience: TOKEN_AUDIENCE,
    pageClientId,
    timestamp: Date.now(),
    runtimeVersion: '0.1.0',
    capabilities: [],
    page: { origin: 'http://127.0.0.1:5173', pathname: '/', title: 'Fixture' }
  };
}

function metadataPayload(pageClientId = 'page_client_1234'): Record<string, unknown> {
  return {
    protocolVersion: '1.0',
    sessionId: 'session_1234',
    browserToken: BROWSER_TOKEN,
    tokenAudience: TOKEN_AUDIENCE,
    pageClientId,
    sourceId: record.sourceId,
    timestamp: Date.now()
  };
}

function selectionPayload(
  pageClientId = 'page_client_1234',
  requestId = 'browser_request_1234'
): Record<string, unknown> {
  return {
    protocolVersion: '1.0',
    sessionId: 'session_1234',
    browserToken: BROWSER_TOKEN,
    tokenAudience: TOKEN_AUDIENCE,
    pageClientId,
    sourceId: record.sourceId,
    candidateKind: 'element',
    modifiers: { shift: false, alt: false },
    page: { origin: 'http://127.0.0.1:5173', pathname: '/', title: 'Fixture' },
    requestId,
    timestamp: Date.now()
  };
}

function heartbeatPayload(pageClientId = 'page_client_1234'): Record<string, unknown> {
  return {
    protocolVersion: '1.0',
    sessionId: 'session_1234',
    browserToken: BROWSER_TOKEN,
    tokenAudience: TOKEN_AUDIENCE,
    pageClientId,
    sequence: 3,
    timestamp: Date.now()
  };
}

describe('BrowserRouter', () => {
  it.each([
    ['client.socket._socket.remoteAddress', 'socket._socket'],
    ['client.socket.remoteAddress', 'socket'],
    ['client._socket.remoteAddress', '_socket'],
  ] as const)('从 %s 读取 Vite socket 地址', (_label, path) => {
    const router = createRouter();
    const client = createClientForAddressPath(path, '127.0.0.1');

    router.handleHello(helloPayload(), client);

    expect(router.getTabs()).toHaveLength(1);
  });

  it('缺失、空值或非字符串 socket 地址时不注册页面', () => {
    const diagnostics = vi.fn();
    const router = createRouter({ diagnostics });
    const missingClient = createClientForAddressPath('socket._socket', '');
    const malformedClient = createClientForAddressPath('socket', '127.0.0.1');
    if (malformedClient.socket) {
      malformedClient.socket.remoteAddress = 42 as unknown as string;
    }

    router.handleHello(helloPayload('page_client_missing'), missingClient);
    router.handleHello(helloPayload('page_client_malformed'), malformedClient);

    expect(router.getTabs()).toEqual([]);
    expect(diagnostics).toHaveBeenCalledWith('REMOTE_BROWSER_REJECTED');
  });

  it('拒绝非本机浏览器', () => {
    const router = createRouter();
    const client = createClient('192.168.1.20');
    router.handleHello(helloPayload(), client);
    expect(router.getTabs()).toHaveLength(0);
  });

  it('接受相同 major 的较新协议 minor 版本', () => {
    const router = createRouter();
    const client = createClient();

    router.handleHello({ ...helloPayload(), protocolVersion: '1.1' }, client);

    expect(router.getTabs()).toHaveLength(1);
  });

  it('拒绝 allowlist 外的页面 origin', () => {
    const diagnostics = vi.fn();
    const router = createRouter({ diagnostics });
    const client = createClient();

    router.handleHello({
      ...helloPayload(),
      page: { origin: 'http://127.0.0.1:9999', pathname: '/', title: 'Other' }
    }, client);

    expect(router.getTabs()).toEqual([]);
    expect(diagnostics).toHaveBeenCalledWith('BROWSER_ORIGIN_REJECTED');
  });

  it('只为已绑定页面响应 heartbeat', () => {
    const router = createRouter();
    const client = createClient();
    router.handleHello(helloPayload(), client);

    router.handleHeartbeat(heartbeatPayload(), client);

    expect(client.sent).toContainEqual([
      'wsi:server:heartbeat',
      expect.objectContaining({ sequence: 3, acknowledged: true })
    ]);
  });

  it('只向绑定 tab 返回元数据和打开结果', () => {
    const requestOpenSource = vi.fn(() => ({ accepted: true as const, messageId: 'open-1' }));
    const bridge = {
      requestOpenSource,
      notifyTabsChanged: vi.fn(),
      dispose: vi.fn()
    } as unknown as LoopbackBridge;
    const router = createRouter();
    const client = createClient();
    router.setBridge(bridge);
    router.handleHello(helloPayload(), client);
    router.handleMetadataRequest(metadataPayload(), client);
    router.handleSelection(selectionPayload(), client);

    expect(client.sent.some(([event]) => event === 'wsi:browser:metadata')).toBe(true);
    const metadata = client.sent.find(([event]) => event === 'wsi:browser:metadata')?.[1];
    expect(metadata).not.toHaveProperty('relativePath');
    expect(metadata).not.toHaveProperty('range');
    expect(metadata).not.toHaveProperty('candidates');
    expect(requestOpenSource).toHaveBeenCalledOnce();
  });

  it('拒绝选择请求切换已绑定的 origin 或 pathname', () => {
    const requestOpenSource = vi.fn(() => ({ accepted: true as const, messageId: 'open-1' }));
    const diagnostics = vi.fn();
    const router = createRouter({ diagnostics });
    router.setBridge({
      requestOpenSource,
      notifyTabsChanged: vi.fn(),
      dispose: vi.fn()
    } as unknown as LoopbackBridge);
    const client = createClient();
    router.handleHello(helloPayload(), client);

    router.handleSelection({
      ...selectionPayload(),
      page: {
        origin: 'http://127.0.0.1:5173',
        pathname: '/other',
        title: 'Other'
      }
    }, client);

    expect(requestOpenSource).not.toHaveBeenCalled();
    expect(diagnostics).toHaveBeenCalledWith('BROWSER_PAGE_BINDING_REJECTED');
  });

  it('重复 hello 不重置 tab 选择限频状态', () => {
    const requestOpenSource = vi.fn(() => ({ accepted: true as const, messageId: 'open-1' }));
    const router = createRouter();
    router.setBridge({
      requestOpenSource,
      notifyTabsChanged: vi.fn(),
      dispose: vi.fn()
    } as unknown as LoopbackBridge);
    const client = createClient();
    const selection = selectionPayload();
    router.handleHello(helloPayload(), client);
    router.handleSelection(selection, client);
    router.handleHello(helloPayload(), client);
    router.handleSelection({ ...selection, timestamp: Date.now() }, client);

    expect(requestOpenSource).toHaveBeenCalledOnce();
    expect(client.sent.some(([event, payload]) => (
      event === 'wsi:browser:result'
      && (payload as { code?: string }).code === 'RATE_LIMITED'
    ))).toBe(true);
  });

  it('重连复用 pageClientId 时旧请求结果仍返回发起 client', () => {
    const router = createRouter();
    router.setBridge({
      requestOpenSource: () => ({ accepted: true, messageId: 'open-route-1' }),
      notifyTabsChanged: vi.fn(),
      dispose: vi.fn()
    } as unknown as LoopbackBridge);
    const firstClient = createClient();
    if (firstClient.socket) {
      firstClient.socket.readyState = 1;
    }
    router.handleHello(helloPayload(), firstClient);
    router.handleSelection(selectionPayload(), firstClient);
    if (firstClient.socket) {
      firstClient.socket.readyState = 3;
    }
    const reconnectedClient = createClient();
    if (reconnectedClient.socket) {
      reconnectedClient.socket.readyState = 1;
    }
    router.handleHello(helloPayload(), reconnectedClient);
    router.sendResult({
      openRequestId: 'open-route-1',
      pageClientId: 'page_client_1234',
      ok: true,
      relativePath: 'src/App.vue',
      line: 10,
      accuracy: 'exact'
    });

    expect(firstClient.sent.some(([event]) => event === 'wsi:browser:result')).toBe(true);
    expect(reconnectedClient.sent.some(([event]) => event === 'wsi:browser:result')).toBe(false);
    expect(firstClient.sent.find(([event]) => event === 'wsi:browser:result')?.[1]).toMatchObject({
      requestId: 'browser_request_1234'
    });
    expect(firstClient.sent.find(([event]) => event === 'wsi:browser:result')?.[1])
      .not.toHaveProperty('relativePath');
  });

  it('dispose 后同一 HMR client 可以注册新的 pageClientId', () => {
    const router = createRouter();
    const client = createClient();
    router.handleHello(helloPayload('page_client_old1'), client);
    router.handleDispose({
      protocolVersion: '1.0',
      sessionId: 'session_1234',
      browserToken: BROWSER_TOKEN,
      tokenAudience: TOKEN_AUDIENCE,
      pageClientId: 'page_client_old1',
      timestamp: Date.now(),
      reason: 'hmr'
    }, client);
    router.handleHello(helloPayload('page_client_new1'), client);

    expect(router.getTabs().map((tab) => tab.pageClientId)).toEqual(['page_client_new1']);
  });

  it('拒绝协议未知字段和过短 sourceId，不调用源码解析', () => {
    const resolveSource = vi.fn(() => ({ status: 'found' as const, record }));
    const router = createRouter({ resolveSource });
    const client = createClient();
    router.handleHello(helloPayload(), client);
    router.handleMetadataRequest({
      ...metadataPayload(),
      sourceId: 'short',
      extra: true
    }, client);

    expect(resolveSource).not.toHaveBeenCalled();
  });

  it('活动 client 占用 pageClientId 时拒绝新 client 接管', () => {
    const diagnostics = vi.fn();
    const router = createRouter({ diagnostics });
    const activeClient = createClient();
    const contender = createClient();
    if (activeClient.socket) {
      activeClient.socket.readyState = 1;
    }
    if (contender.socket) {
      contender.socket.readyState = 1;
    }
    router.handleHello(helloPayload(), activeClient);
    router.handleHello(helloPayload(), contender);

    expect(router.getTabs()).toHaveLength(1);
    expect(diagnostics).toHaveBeenCalledWith('PAGE_CLIENT_ID_CONFLICT');
    router.handleMetadataRequest(metadataPayload(), contender);
    expect(contender.sent.some(([event]) => event === 'wsi:browser:metadata')).toBe(false);
  });

  it('阻止不符合 Vite 到 Browser 协议的结果', () => {
    const diagnostics = vi.fn();
    const router = createRouter({ diagnostics });
    const client = createClient();
    router.handleHello(helloPayload(), client);
    router.sendResult({
      pageClientId: 'page_client_1234',
      ok: false,
      code: 'NOT_A_PROTOCOL_CODE'
    });

    expect(diagnostics).toHaveBeenCalledWith(
      'INVALID_SERVER_BROWSER_PAYLOAD:wsi:browser:result:$.code'
    );
    expect(client.sent.some(([event]) => event === 'wsi:browser:result')).toBe(false);
  });
});
