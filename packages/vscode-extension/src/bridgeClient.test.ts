import { describe, expect, it } from 'vitest';

import {
  buildLoopbackBridgeUrl,
  computeReconnectDelay,
  createBridgeHandshake,
  createIdeHelloPayload,
  createIdeOpenResultPayload,
  parseBrowserTabs,
  parseServerHelloAckPayload,
} from './bridgeClient';
import { BRIDGE_SUBPROTOCOL, type ServerOpenSourcePayload } from './types';

describe('Bridge connection helpers', () => {
  it('always builds a literal IPv4 loopback URL', () => {
    expect(buildLoopbackBridgeUrl({ port: 51_234, bridgePath: '/bridge/session' })).toBe(
      'ws://127.0.0.1:51234/bridge/session',
    );
  });

  it('uses the fixed subprotocol and bearer Authorization header', () => {
    expect(createBridgeHandshake({ port: 51_234, bridgePath: '/wsi/session', token: 'secret-token' })).toEqual({
      url: 'ws://127.0.0.1:51234/wsi/session',
      subprotocol: BRIDGE_SUBPROTOCOL,
      headers: { Authorization: 'Bearer secret-token' },
    });
  });

  it('uses bounded exponential backoff with jitter', () => {
    expect(computeReconnectDelay(0, () => 0)).toBe(375);
    expect(computeReconnectDelay(0, () => 1)).toBe(625);
    expect(computeReconnectDelay(99, () => 1)).toBe(37_500);
  });
});

describe('Bridge wire payloads', () => {
  it('builds the hello payload accepted by the Vite bridge', () => {
    expect(
      createIdeHelloPayload(
        { ideClientId: 'ide-1', ideName: 'Cursor', extensionVersion: '0.1.0' },
        [{ rootKey: 'root-1', canonicalPath: 'D:\\project' }],
        ['open-source'],
        true,
      ),
    ).toEqual({
      ideClientId: 'ide-1',
      ideName: 'Cursor',
      extensionVersion: '0.1.0',
      workspaceRoots: [{ rootKey: 'root-1', canonicalPath: 'D:\\project' }],
      capabilities: ['open-source'],
      focused: true,
    });
  });

  it('parses hello and tab payloads using browserTabs/pathname fields', () => {
    const browserTabs = [
      { pageClientId: 'page-1', pathname: '/demo', title: 'Demo', connectedAt: 1_000 },
    ];
    expect(parseBrowserTabs(browserTabs)).toEqual(browserTabs);
    expect(
      parseServerHelloAckPayload(
        {
          authenticated: true,
          session: {
            sessionId: 'session-1',
            projectName: 'fixture',
            canonicalRoots: [{ rootKey: 'root-1', displayName: 'fixture' }],
            capabilities: ['open-source'],
          },
          browserTabs,
        },
        'session-1',
      ),
    ).toMatchObject({ authenticated: true, browserTabs });
    expect(parseBrowserTabs([{ pageClientId: 'page-1', url: 'http://localhost:5173', connectedAt: 1_000 }])).toBeUndefined();
  });

  it('maps editor results to requestMessageId/ok open-result fields', () => {
    const request: ServerOpenSourcePayload = {
      openRequestId: 'open-1',
      pageClientId: 'page-1',
      rootKey: 'root-1',
      relativePath: 'src/App.vue',
      range: {
        startLine: 4,
        startColumn: 3,
        endLine: 4,
        endColumn: 8,
        startOffset: 20,
        endOffset: 25,
      },
      sourceDigest: 'sha256:test',
      contextBefore: null,
      contextAfter: null,
      accuracy: 'exact',
      candidateKind: 'element',
      tagName: 'div',
      componentName: null,
      page: { origin: 'http://localhost:5173', pathname: '/', title: 'Fixture' },
      candidates: [],
    };
    expect(
      createIdeOpenResultPayload(request, {
        openRequestId: 'open-1',
        success: true,
        code: 'RANGE_ADJUSTED',
        range: { ...request.range, startLine: 6 },
      }),
    ).toEqual({
      requestMessageId: 'open-1',
      ok: true,
      code: 'RANGE_ADJUSTED',
      relativePath: 'src/App.vue',
      line: 6,
      accuracy: 'exact',
    });
  });
});
