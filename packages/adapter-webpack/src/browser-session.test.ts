import { createSourceDigest, type SourceRecord } from '@web-source-inspector/compiler-core';
import { browserEvents } from '@web-source-inspector/dev-session-core';
import { PROTOCOL_VERSION } from '@web-source-inspector/protocol';
import { describe, expect, it } from 'vitest';

import { WebSourceInspectorWebpackPlugin } from './plugin.js';
import {
  createWebpackAdapterSession,
  disposeWebpackAdapterSession,
} from './registry.js';
import type {
  WebpackBrowserClientContext,
  WebpackCompilerLike,
} from './types.js';

describe('Webpack BrowserRouter binding', () => {
  it('把 transport event envelope 路由到统一 BrowserRouter 和 Manifest', async () => {
    const compiler: WebpackCompilerLike = {
      options: { mode: 'development', context: process.cwd() },
    };
    const session = createWebpackAdapterSession(
      compiler,
      {
        allowedOrigins: ['http://127.0.0.1:8080'],
        bridge: false,
      },
      17,
      '5.99.0',
      WebSourceInspectorWebpackPlugin.loaderPath,
    );
    const credential = session.browserCredential;
    const handler = session.browserMessageHandler;
    if (!credential || !handler) {
      throw new Error('Browser session 未创建');
    }
    const source = '<template><div /></template>';
    const moduleId = 'src/App.vue';
    const fullDigest = createSourceDigest(source);
    const generation = session.manifest.allocateGeneration(moduleId, fullDigest);
    const range = {
      startLine: 1,
      startColumn: 11,
      endLine: 1,
      endColumn: 18,
      startOffset: 10,
      endOffset: 17,
    };
    const sourceId = session.createSourceId({
      normalizedRelativePath: moduleId,
      moduleGeneration: generation,
      nodeKind: 'element',
      tagName: 'div',
      range,
      localSnippetDigest: createSourceDigest('<div />'),
    });
    const record: SourceRecord = {
      sourceId,
      rootKey: session.rootKey,
      relativePath: moduleId,
      framework: 'vue',
      kind: 'element',
      tagName: 'div',
      range,
      componentName: 'App',
      controlFlow: null,
      parentSourceId: null,
      sourceDigest: fullDigest,
      contextBefore: null,
      contextAfter: null,
      moduleId,
      generation,
      accuracy: 'exact',
    };
    session.manifest.replaceModule(moduleId, generation, [record]);

    const sent: Array<{ event: string; payload: unknown }> = [];
    const client: WebpackBrowserClientContext = {
      pageClientId: 'page_client_1234',
      connectionId: 'connection_1234',
      remoteAddress: '127.0.0.1',
      send(event, payload) {
        sent.push({ event, payload });
      },
      isOpen: () => true,
    };
    const browserContext = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.compilerSessionId,
      pageClientId: client.pageClientId,
      timestamp: Date.now(),
      browserToken: credential.browserToken,
      tokenAudience: 'browser-transport' as const,
    };
    await handler.onMessage?.(
      {
        event: browserEvents.hello,
        payload: {
          ...browserContext,
          runtimeVersion: '0.1.0',
          capabilities: [],
          page: {
            origin: 'http://127.0.0.1:8080',
            pathname: '/',
            title: 'Fixture',
          },
        },
      },
      client,
    );
    await handler.onMessage?.(
      {
        event: browserEvents.metadataRequest,
        payload: { ...browserContext, timestamp: Date.now(), sourceId },
      },
      client,
    );

    expect(sent.map((message) => message.event)).toEqual([
      browserEvents.connection,
      browserEvents.metadata,
    ]);
    expect(sent[1]?.payload).toMatchObject({ sourceId, tagName: 'div' });
    disposeWebpackAdapterSession(compiler);
  });
});
