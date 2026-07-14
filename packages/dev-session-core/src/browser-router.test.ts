import type { SourceRecord } from '@web-source-inspector/compiler-core';
import {
  BROWSER_EVENTS,
  BROWSER_TOKEN_AUDIENCE,
  PROTOCOL_VERSION,
} from '@web-source-inspector/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  BrowserRouter,
  type BrowserTransportClient,
} from './browser-router.js';
import {
  createBrowserAddressPolicy,
  createBrowserAddressSnapshot,
} from './browser-address.js';
import type { LoopbackBridge } from './bridge-types.js';

const SESSION_ID = 'session_router_core';
const BROWSER_TOKEN = 'b'.repeat(43);
const PAGE_CLIENT_ID = 'page_router_core';
const ORIGIN = 'http://127.0.0.1:5173';

const record: SourceRecord = {
  sourceId: 'a'.repeat(43),
  rootKey: 'root_router_core',
  relativePath: 'src/App.vue',
  framework: 'vue',
  kind: 'element',
  tagName: 'button',
  range: {
    startLine: 2,
    startColumn: 3,
    endLine: 2,
    endColumn: 11,
    startOffset: 12,
    endOffset: 20,
  },
  componentName: 'App',
  controlFlow: null,
  parentSourceId: null,
  sourceDigest: `sha256:${'c'.repeat(64)}`,
  contextBefore: '<template>',
  contextAfter: '</template>',
  moduleId: 'D:/workspace/src/App.vue',
  generation: 1,
  accuracy: 'exact',
};

function createClient(remoteAddress: string | null = '127.0.0.1') {
  const sent: Array<[string, unknown]> = [];
  let open = true;
  const client: BrowserTransportClient = {
    remoteAddress,
    isOpen: () => open,
    send(event, payload) {
      sent.push([event, payload]);
    },
  };
  return {
    client,
    sent,
    close() {
      open = false;
    },
  };
}

function browserContext(pageClientId = PAGE_CLIENT_ID) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    pageClientId,
    timestamp: Date.now(),
    browserToken: BROWSER_TOKEN,
    tokenAudience: BROWSER_TOKEN_AUDIENCE,
  };
}

function helloPayload(pageClientId = PAGE_CLIENT_ID, origin = ORIGIN) {
  return {
    ...browserContext(pageClientId),
    runtimeVersion: '0.1.0',
    capabilities: [],
    page: { origin, pathname: '/', title: 'Fixture' },
  };
}

describe('bundler-neutral BrowserRouter', () => {
  it('只依赖 adapter 提供的 remoteAddress 并拒绝远程连接', () => {
    const diagnostics: string[] = [];
    const router = new BrowserRouter({
      sessionId: SESSION_ID,
      browserToken: BROWSER_TOKEN,
      browserAddressPolicy: createBrowserAddressPolicy({ mode: 'loopback' }),
      allowedOrigins: [ORIGIN],
      resolveSource: () => ({ status: 'found', record }),
      diagnostics: (message) => diagnostics.push(message),
    });
    const remote = createClient('192.168.1.30');

    router.handleHello(helloPayload(), remote.client);

    expect(router.getTabs()).toEqual([]);
    expect(diagnostics).toEqual(['REMOTE_BROWSER_REJECTED']);
    expect(remote.sent).toContainEqual([
      BROWSER_EVENTS.connection,
      expect.objectContaining({
        connected: false,
        message: '当前浏览器地址未授权',
      }),
    ]);
  });

  it('Browser 输出不包含服务端源码路径并把完整记录只送往 Bridge', () => {
    const requestOpenSource = vi.fn(() => ({ accepted: true as const, messageId: 'open-core' }));
    const router = new BrowserRouter({
      sessionId: SESSION_ID,
      browserToken: BROWSER_TOKEN,
      browserAddressPolicy: createBrowserAddressPolicy({ mode: 'loopback' }),
      allowedOrigins: [ORIGIN],
      resolveSource: () => ({ status: 'found', record }),
    });
    router.setBridge({
      requestOpenSource,
      notifyTabsChanged: vi.fn(),
      dispose: vi.fn(),
    } as unknown as LoopbackBridge);
    const browser = createClient();
    router.handleHello(helloPayload(), browser.client);
    router.handleMetadataRequest({
      ...browserContext(),
      sourceId: record.sourceId,
    }, browser.client);
    router.handleSelection({
      ...browserContext(),
      sourceId: record.sourceId,
      candidateKind: 'element',
      modifiers: { shift: false, alt: false },
      page: { origin: ORIGIN, pathname: '/', title: 'Fixture' },
      requestId: 'request_router_core',
    }, browser.client);

    const metadata = browser.sent.find(([event]) => event === BROWSER_EVENTS.metadata)?.[1];
    expect(metadata).not.toHaveProperty('relativePath');
    expect(metadata).not.toHaveProperty('range');
    expect(requestOpenSource).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'src/App.vue', range: record.range }),
    );
  });

  it('仅在旧 transport 明确关闭后允许 pageClientId 重连', () => {
    const router = new BrowserRouter({
      sessionId: SESSION_ID,
      browserToken: BROWSER_TOKEN,
      browserAddressPolicy: createBrowserAddressPolicy({ mode: 'loopback' }),
      allowedOrigins: [ORIGIN],
      resolveSource: () => ({ status: 'found', record }),
    });
    const first = createClient();
    const second = createClient();
    router.handleHello(helloPayload(), first.client);
    router.handleHello(helloPayload(), second.client);
    expect(router.getTabs()).toHaveLength(1);
    expect(second.sent).toEqual([]);

    first.close();
    router.handleHello(helloPayload(), second.client);

    expect(router.getTabs()).toHaveLength(1);
    expect(second.sent.some(([event]) => event === BROWSER_EVENTS.connection)).toBe(true);
  });

  it('same-machine 接受快照中的 mapped IPv6 socket 和同一 IPv4 Origin', () => {
    const localOrigin = 'http://192.168.8.155:5173';
    const router = new BrowserRouter({
      sessionId: SESSION_ID,
      browserToken: BROWSER_TOKEN,
      browserAddressPolicy: createBrowserAddressPolicy({
        mode: 'same-machine',
        snapshot: createBrowserAddressSnapshot({ addresses: ['192.168.8.155'] }),
      }),
      allowedOrigins: [localOrigin],
      resolveSource: () => ({ status: 'found', record }),
    });
    const browser = createClient('::ffff:192.168.8.155');

    router.handleHello(helloPayload(PAGE_CLIENT_ID, localOrigin), browser.client);

    expect(router.getTabs()).toHaveLength(1);
    expect(browser.sent).toContainEqual([
      BROWSER_EVENTS.connection,
      expect.objectContaining({ connected: false }),
    ]);
  });

  it('拒绝地址或 Origin 后发送未授权 connection，且不注册 tab 或通知 Bridge', () => {
    const diagnostics: string[] = [];
    const notifyTabsChanged = vi.fn();
    const router = new BrowserRouter({
      sessionId: SESSION_ID,
      browserToken: BROWSER_TOKEN,
      browserAddressPolicy: createBrowserAddressPolicy({
        mode: 'same-machine',
        snapshot: createBrowserAddressSnapshot({ addresses: ['192.168.8.155'] }),
      }),
      allowedOrigins: ['http://192.168.8.155:5173'],
      resolveSource: () => ({ status: 'found', record }),
      diagnostics: (message) => diagnostics.push(message),
    });
    router.setBridge({
      requestOpenSource: vi.fn(),
      notifyTabsChanged,
      dispose: vi.fn(),
    } as unknown as LoopbackBridge);
    notifyTabsChanged.mockClear();

    const otherLanBrowser = createClient('192.168.8.156');
    router.handleHello(
      helloPayload(PAGE_CLIENT_ID, 'http://192.168.8.156:5173'),
      otherLanBrowser.client,
    );

    const forgedOriginBrowser = createClient('192.168.8.155');
    router.handleHello(
      helloPayload('page_router_origin', 'http://localhost:5173'),
      forgedOriginBrowser.client,
    );

    expect(diagnostics).toEqual([
      'BROWSER_SAME_MACHINE_REJECTED',
      'BROWSER_ORIGIN_REJECTED',
    ]);
    expect(otherLanBrowser.sent).toContainEqual([
      BROWSER_EVENTS.connection,
      expect.objectContaining({
        connected: false,
        message: '当前浏览器地址未授权',
      }),
    ]);
    expect(forgedOriginBrowser.sent).toContainEqual([
      BROWSER_EVENTS.connection,
      expect.objectContaining({
        connected: false,
        message: '当前浏览器地址未授权',
      }),
    ]);
    expect(router.getTabs()).toEqual([]);
    expect(notifyTabsChanged).not.toHaveBeenCalled();
  });

  it('same-machine 拒绝缺失或非法 socket 地址', () => {
    const policy = createBrowserAddressPolicy({
      mode: 'same-machine',
      snapshot: createBrowserAddressSnapshot({ addresses: ['192.168.8.155'] }),
    });
    for (const remoteAddress of [null, 'not-an-address']) {
      const diagnostics: string[] = [];
      const router = new BrowserRouter({
        sessionId: SESSION_ID,
        browserToken: BROWSER_TOKEN,
        browserAddressPolicy: policy,
        allowedOrigins: ['http://192.168.8.155:5173'],
        resolveSource: () => ({ status: 'found', record }),
        diagnostics: (message) => diagnostics.push(message),
      });
      const browser = createClient(remoteAddress);

      router.handleHello(
        helloPayload(`page_router_${remoteAddress ?? 'missing'}`, 'http://192.168.8.155:5173'),
        browser.client,
      );

      expect(router.getTabs()).toEqual([]);
      expect(diagnostics).toEqual(['BROWSER_SAME_MACHINE_REJECTED']);
      expect(browser.sent).toContainEqual([
        BROWSER_EVENTS.connection,
        expect.objectContaining({ message: '当前浏览器地址未授权' }),
      ]);
    }
  });

  it('selection 不能切换 hello 时绑定的 Origin', () => {
    const requestOpenSource = vi.fn(() => ({
      accepted: true as const,
      messageId: 'open-router-origin',
    }));
    const diagnostics: string[] = [];
    const router = new BrowserRouter({
      sessionId: SESSION_ID,
      browserToken: BROWSER_TOKEN,
      browserAddressPolicy: createBrowserAddressPolicy({ mode: 'loopback' }),
      allowedOrigins: [ORIGIN, 'http://localhost:5173'],
      resolveSource: () => ({ status: 'found', record }),
      diagnostics: (message) => diagnostics.push(message),
    });
    router.setBridge({
      requestOpenSource,
      notifyTabsChanged: vi.fn(),
      dispose: vi.fn(),
    } as unknown as LoopbackBridge);
    const browser = createClient();
    router.handleHello(helloPayload(), browser.client);

    router.handleSelection({
      ...browserContext(),
      sourceId: record.sourceId,
      candidateKind: 'element',
      modifiers: { shift: false, alt: false },
      page: { origin: 'http://localhost:5173', pathname: '/', title: 'Fixture' },
      requestId: 'request_router_origin',
    }, browser.client);

    expect(diagnostics).toContain('BROWSER_PAGE_BINDING_REJECTED');
    expect(requestOpenSource).not.toHaveBeenCalled();
  });
});
