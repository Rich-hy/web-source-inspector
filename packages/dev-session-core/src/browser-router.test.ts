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

function helloPayload(pageClientId = PAGE_CLIENT_ID) {
  return {
    ...browserContext(pageClientId),
    runtimeVersion: '0.1.0',
    capabilities: [],
    page: { origin: ORIGIN, pathname: '/', title: 'Fixture' },
  };
}

describe('bundler-neutral BrowserRouter', () => {
  it('只依赖 adapter 提供的 remoteAddress 并拒绝远程连接', () => {
    const router = new BrowserRouter({
      sessionId: SESSION_ID,
      browserToken: BROWSER_TOKEN,
      allowRemoteBrowser: false,
      allowedOrigins: [ORIGIN],
      resolveSource: () => ({ status: 'found', record }),
    });
    const remote = createClient('192.168.1.30');

    router.handleHello(helloPayload(), remote.client);

    expect(router.getTabs()).toEqual([]);
  });

  it('Browser 输出不包含服务端源码路径并把完整记录只送往 Bridge', () => {
    const requestOpenSource = vi.fn(() => ({ accepted: true as const, messageId: 'open-core' }));
    const router = new BrowserRouter({
      sessionId: SESSION_ID,
      browserToken: BROWSER_TOKEN,
      allowRemoteBrowser: false,
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
      allowRemoteBrowser: false,
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
});
