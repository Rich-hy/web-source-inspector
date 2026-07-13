import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { browserEvents } from '@web-source-inspector/dev-session-core';
import { PROTOCOL_VERSION } from '@web-source-inspector/protocol';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { WebSourceInspectorWebpackPlugin } from './plugin.js';
import webSourceInspectorWebpackLoader from './loader.js';
import { getWebpackAdapterSession } from './registry.js';
import { createRawLoopbackBrowserTransport } from './raw-loopback-transport.js';
import type {
  WebpackCompilationLike,
  WebpackCompilerLike,
  WebpackStatsLike,
  WebpackLoaderContextLike,
} from './types.js';
import {
  createWebSourceInspectorBrowserMiddleware,
  getWebSourceInspectorBrowserTransportDescriptor,
} from './wds-middleware.js';

class MockHook<TArguments extends unknown[]> {
  readonly callbacks: Array<(...arguments_: TArguments) => void> = [];

  tap(_name: string, callback: (...arguments_: TArguments) => void): void {
    this.callbacks.push(callback);
  }

  call(...arguments_: TArguments): void {
    for (const callback of this.callbacks) {
      callback(...arguments_);
    }
  }
}

class MockPromiseHook {
  readonly callbacks: Array<() => Promise<void>> = [];

  tapPromise(_name: string, callback: () => Promise<void>): void {
    this.callbacks.push(callback);
  }

  async call(): Promise<void> {
    for (const callback of this.callbacks) {
      await callback();
    }
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  writableEnded = false;
  readonly headers = new Map<string, string>();
  body = '';

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  end(value = ''): this {
    this.body += value;
    this.writableEnded = true;
    return this;
  }

  write(value: string): boolean {
    this.body += value;
    return true;
  }

  flushHeaders(): void {}
}

class VueLoaderPlugin {}

describe('Webpack browser transports', () => {
  it('无活动 development session 时 middleware factory 返回 null', () => {
    const compiler = { options: { mode: 'production' } } as WebpackCompilerLike;
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      allowedOrigins: ['http://127.0.0.1:8080'],
      bridge: false,
    }).apply(compiler);
    expect(createWebSourceInspectorBrowserMiddleware(compiler)).toBeNull();
  });

  it('WDS factory 幂等，随机 path 外同步 next，错误 Origin 在读 body 前拒绝', () => {
    const watchClose = new MockHook<[]>();
    const compiler = createDevelopmentCompiler(watchClose);
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      allowedOrigins: ['http://127.0.0.1:8080'],
      bridge: false,
    }).apply(compiler);
    const middleware = createWebSourceInspectorBrowserMiddleware(compiler);
    expect(middleware).not.toBeNull();
    expect(createWebSourceInspectorBrowserMiddleware(compiler)).toBe(middleware);
    expect(compiler.options?.entry).toEqual([
      './src/main.js',
      expect.stringMatching(/^!!.*__wsiRuntimeBootstrap=.*!/),
    ]);
    const runtimeRequest = (compiler.options?.entry as string[])[1];
    const query = runtimeRequest?.slice(runtimeRequest.indexOf('?'), runtimeRequest.lastIndexOf('!'));
    const runtimeSource = webSourceInspectorWebpackLoader.call(
      {
        resourcePath: WebSourceInspectorWebpackPlugin.loaderPath,
        resourceQuery: '',
        loaderIndex: 0,
        loaders: [],
        _compiler: compiler,
        query,
      } satisfies WebpackLoaderContextLike,
      'placeholder',
    );
    expect(runtimeSource).toEqual(expect.stringContaining('createInspectorRuntime'));
    expect(runtimeSource).toEqual(expect.stringContaining("'/stream/open'"));
    if (!middleware) {
      throw new Error('测试 middleware 未创建');
    }

    let nextCalls = 0;
    middleware(
      createRequest('/api/user', 'GET', {}),
      new MockResponse() as unknown as ServerResponse,
      () => {
        nextCalls += 1;
      },
    );
    expect(nextCalls).toBe(1);

    const descriptor = getWebSourceInspectorBrowserTransportDescriptor(compiler);
    expect(descriptor).not.toBeNull();
    const response = new MockResponse();
    middleware(
      createRequest(`${descriptor?.basePath}/message`, 'POST', {
        origin: 'http://attacker.invalid',
        host: '127.0.0.1:8080',
        authorization: `Bearer ${descriptor?.browserToken}`,
        'x-wsi-page-client-id': 'page-1',
        'x-wsi-connection-id': 'connection-1',
      }),
      response as unknown as ServerResponse,
      () => undefined,
    );
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe('AUTH_FAILED');
    watchClose.call();
    expect(createWebSourceInspectorBrowserMiddleware(compiler)).toBeNull();
  });

  it('默认 WDS credential 接受严格动态同源，不需要初始化器写 allowlist', () => {
    const watchClose = new MockHook<[]>();
    const compiler = createDevelopmentCompiler(watchClose);
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      bridge: false,
    }).apply(compiler);
    const middleware = createWebSourceInspectorBrowserMiddleware(compiler);
    const descriptor = getWebSourceInspectorBrowserTransportDescriptor(compiler);
    if (!middleware || !descriptor) {
      throw new Error('默认 WDS session 未创建');
    }
    const response = new MockResponse();
    middleware(
      createRequest(`${descriptor.basePath}/message`, 'POST', {
        origin: 'http://127.0.0.1:8080',
        host: '127.0.0.1:8080',
        authorization: `Bearer ${descriptor.browserToken}`,
        'x-wsi-page-client-id': 'page-1',
        'x-wsi-connection-id': 'connection-1',
      }),
      response as unknown as ServerResponse,
      () => undefined,
    );
    expect(response.statusCode).toBe(409);
    expect(response.body).toBe('CLIENT_NOT_REGISTERED');
    expect(getWebpackAdapterSession(compiler)?.wdsCredential?.observedOrigins).toContain(
      'http://127.0.0.1:8080',
    );
    watchClose.call();
  });

  it('已返回的 WDS middleware 在 session 撤销后对旧随机 path fail-closed', () => {
    const watchClose = new MockHook<[]>();
    const compiler = createDevelopmentCompiler(watchClose);
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      bridge: false,
    }).apply(compiler);
    const middleware = createWebSourceInspectorBrowserMiddleware(compiler);
    const descriptor = getWebSourceInspectorBrowserTransportDescriptor(compiler);
    if (!middleware || !descriptor) {
      throw new Error('WDS session 未创建');
    }
    watchClose.call();

    const response = new MockResponse();
    middleware(
      createRequest(`${descriptor.basePath}/message`, 'POST', {
        origin: 'http://127.0.0.1:8080',
        host: '127.0.0.1:8080',
        authorization: `Bearer ${descriptor.browserToken}`,
        'x-wsi-page-client-id': 'page-1',
        'x-wsi-connection-id': 'connection-1',
      }),
      response as unknown as ServerResponse,
      () => undefined,
    );

    expect(response.statusCode).toBe(410);
    expect(response.body).toBe('SESSION_REVOKED');
  });

  it('WDS Connect middleware 通过真实 POST stream 路由 Browser hello', async () => {
    const watchClose = new MockHook<[]>();
    const compiler = createDevelopmentCompiler(watchClose);
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      bridge: false,
    }).apply(compiler);
    const middleware = createWebSourceInspectorBrowserMiddleware(compiler);
    const descriptor = getWebSourceInspectorBrowserTransportDescriptor(compiler);
    const session = getWebpackAdapterSession(compiler);
    if (!middleware || !descriptor || !session) {
      throw new Error('WDS session 未创建');
    }
    const server = http.createServer((request, response) => {
      middleware(request, response, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    const port = await listenOnLoopback(server);
    const origin = `http://127.0.0.1:${port}`;
    const pageClientId = 'page_client_wds_1';
    const connectionId = 'connection_wds_1';
    const headers = {
      Origin: origin,
      Authorization: `Bearer ${descriptor.browserToken}`,
      'X-WSI-Page-Client-Id': pageClientId,
      'X-WSI-Connection-Id': connectionId,
    };
    const abortController = new AbortController();
    const streamResponse = await fetch(`${origin}${descriptor.basePath}/stream/open`, {
      method: 'POST',
      headers,
      signal: abortController.signal,
    });
    expect(streamResponse.status).toBe(200);

    const messageResponse = await fetch(`${origin}${descriptor.basePath}/message`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: browserEvents.hello,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          sessionId: session.compilerSessionId,
          pageClientId,
          timestamp: Date.now(),
          browserToken: descriptor.browserToken,
          tokenAudience: 'browser-transport',
          runtimeVersion: '0.1.0',
          capabilities: [],
          page: { origin, pathname: '/', title: 'WDS fixture' },
        },
      }),
    });
    expect(messageResponse.status).toBe(204);
    const connectionEnvelope = await readFirstNdjsonMessage(streamResponse);
    expect(connectionEnvelope).toMatchObject({
      event: browserEvents.connection,
      payload: { sessionId: session.compilerSessionId, pageClientId },
    });

    abortController.abort();
    watchClose.call();
    await closeServer(server);
  });

  it('raw transport 拒绝 HTTPS origin，且不消费随机 path 外的 upgrade', () => {
    expect(() =>
      createRawLoopbackBrowserTransport({ allowedOrigins: ['https://127.0.0.1:8443'] }),
    ).toThrow(/不支持 HTTPS/);

    const transport = createRawLoopbackBrowserTransport({
      allowedOrigins: ['http://127.0.0.1:8080'],
    });
    const consumed = transport.handleUpgrade(
      { url: '/webpack-hmr' } as IncomingMessage,
      {} as Duplex,
      Buffer.alloc(0),
    );
    expect(consumed).toBe(false);
    expect(transport.descriptor.path).toMatch(/^\/__wsi\/raw\/[A-Za-z0-9_-]+$/);
    expect(transport.descriptor.browserToken).toHaveLength(43);
    transport.dispose();
  });

  it('raw 模式的一次性 build 只产出空占位，watchRun 后才生成 runtime', async () => {
    const watchRun = new MockPromiseHook();
    const watchClose = new MockHook<[]>();
    const compiler = {
      options: {
        mode: 'development',
        context: process.cwd(),
        entry: './src/main.js',
        module: {
          rules: [{
            use: [
              WebSourceInspectorWebpackPlugin.loaderPath,
              'C:/workspace/node_modules/vue-loader/dist/index.js',
            ],
          }],
        },
        plugins: [new VueLoaderPlugin()],
      },
      webpack: { version: '5.99.0' },
      hooks: {
        afterPlugins: new MockHook<[WebpackCompilerLike]>(),
        thisCompilation: new MockHook<[WebpackCompilationLike]>(),
        done: new MockHook<[WebpackStatsLike]>(),
        watchRun,
        watchClose,
      },
    } as unknown as WebpackCompilerLike;
    new WebSourceInspectorWebpackPlugin({
      vueLoaderMajor: 17,
      browserTransport: 'raw',
      allowedOrigins: ['http://127.0.0.1:8080'],
      bridge: false,
    }).apply(compiler);

    const beforeWatch = getWebpackAdapterSession(compiler);
    expect(beforeWatch?.rawServer).toBeNull();
    expect(beforeWatch?.runtimeInjected).toBe(false);
    const rawRuntimeRequest = (compiler.options?.entry as string[])[1] ?? '';
    expect(rawRuntimeRequest).toMatch(/__wsiRawRuntime=/);
    expect(rawRuntimeRequest).not.toContain(beforeWatch?.rawCredential?.browserToken ?? 'missing');
    const rawRuntimeQuery = rawRuntimeRequest.slice(
      rawRuntimeRequest.indexOf('?'),
      rawRuntimeRequest.lastIndexOf('!'),
    );
    let cacheableValue: boolean | undefined;
    const rawLoaderContext = {
      resourcePath: WebSourceInspectorWebpackPlugin.loaderPath,
      resourceQuery: '',
      loaderIndex: 0,
      loaders: [],
      _compiler: compiler,
      query: rawRuntimeQuery,
      cacheable(value = true) {
        cacheableValue = value;
      },
    } satisfies WebpackLoaderContextLike;
    expect(
      webSourceInspectorWebpackLoader.call(rawLoaderContext, 'placeholder'),
    ).toBe('export {};');
    expect(cacheableValue).toBe(false);

    await watchRun.call();

    const active = getWebpackAdapterSession(compiler);
    expect(active?.rawServer?.port).toBeGreaterThan(0);
    expect(active?.runtimeInjected).toBe(true);
    const rawRuntimeSource = webSourceInspectorWebpackLoader.call(
      rawLoaderContext,
      'placeholder',
    );
    expect(rawRuntimeSource).toEqual(expect.stringContaining('new WebSocket'));
    expect(rawRuntimeSource).toEqual(
      expect.stringContaining(`"port":${active?.rawServer?.port}`),
    );
    expect(rawRuntimeSource).toEqual(
      expect.stringContaining(active?.rawCredential?.browserToken ?? 'missing'),
    );

    if (!active?.rawServer || !active.rawCredential) {
      throw new Error('raw watch server 未启动');
    }
    const pageClientId = 'page_client_raw_1';
    const connectionEnvelope = await connectRawBrowser(
      active.rawServer.port,
      active.rawCredential.basePath,
      active.rawCredential.browserToken,
      active.compilerSessionId,
      pageClientId,
    );
    expect(connectionEnvelope).toMatchObject({
      event: browserEvents.connection,
      payload: {
        sessionId: active.compilerSessionId,
        pageClientId,
        connected: false,
      },
    });

    watchClose.call();
    expect(getWebpackAdapterSession(compiler)).toBeNull();
  });
});

function createDevelopmentCompiler(watchClose: MockHook<[]>): WebpackCompilerLike {
  return {
    options: {
      mode: 'development',
      context: 'C:/workspace',
      entry: './src/main.js',
      module: {
        rules: [{
          use: [
            WebSourceInspectorWebpackPlugin.loaderPath,
            'C:/workspace/node_modules/vue-loader/dist/index.js',
          ],
        }],
      },
      plugins: [new VueLoaderPlugin()],
    },
    hooks: {
      afterPlugins: new MockHook<[WebpackCompilerLike]>(),
      thisCompilation: new MockHook<[WebpackCompilationLike]>(),
      done: new MockHook<[WebpackStatsLike]>(),
      watchClose,
    },
  } as unknown as WebpackCompilerLike;
}

function connectRawBrowser(
  port: number,
  transportPath: string,
  browserToken: string,
  sessionId: string,
  pageClientId: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${transportPath}?pageClientId=${pageClientId}`,
      ['wsi-browser-v1', `wsi-token.${browserToken}`],
      { origin: 'http://127.0.0.1:8080' },
    );
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('raw BrowserRouter 响应超时'));
    }, 2_000);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('open', () => {
      socket.send(JSON.stringify({
        event: browserEvents.hello,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          pageClientId,
          timestamp: Date.now(),
          browserToken,
          tokenAudience: 'browser-transport',
          runtimeVersion: '0.1.0',
          capabilities: [],
          page: {
            origin: 'http://127.0.0.1:8080',
            pathname: '/',
            title: 'Raw fixture',
          },
        },
      }));
    });
    socket.once('message', (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()) as unknown);
      } catch (error) {
        reject(error);
      } finally {
        socket.close();
      }
    });
  });
}

function listenOnLoopback(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('测试 HTTP server 未取得端口'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function readFirstNdjsonMessage(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('stream response 没有 body');
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error('WDS stream 响应超时')), 2_000);
  });
  const read = (async (): Promise<unknown> => {
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const result = await reader.read();
      if (result.done) {
        throw new Error('WDS stream 提前关闭');
      }
      pending += decoder.decode(result.value, { stream: true });
      const lineEnd = pending.indexOf('\n');
      if (lineEnd >= 0) {
        return JSON.parse(pending.slice(0, lineEnd)) as unknown;
      }
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
): IncomingMessage {
  return {
    url,
    method,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}
