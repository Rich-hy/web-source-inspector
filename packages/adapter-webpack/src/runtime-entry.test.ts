import { describe, expect, it, vi } from 'vitest';

import {
  createWebpackRuntimeClientSource,
  WEBPACK_RUNTIME_GUARD,
} from './runtime-entry.js';
import type { WsiRuntimeBootstrapOptions } from './types.js';

interface RuntimeTransport {
  send(event: string, payload: unknown): void;
  dispose(): void;
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.#emit('close', {});
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.#emit('open', {});
  }

  disconnect(): void {
    this.close();
  }

  #emit(event: string, payload: { data?: unknown }): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

describe('Webpack runtime client source', () => {
  it('WDS 与 raw 生成源码不包含 Webpack 4 parser 不支持的赋值或可选链语法', () => {
    for (const options of [createWdsOptions(), createRawOptions()]) {
      const source = createWebpackRuntimeClientSource(options);
      expect(source).not.toMatch(/\|\|=|&&=|\?\?=|\?\.|\?\?/);
    }
  });

  it('WDS 连接失败后退避重连，并把待发消息限制在 64 条', async () => {
    vi.useFakeTimers();
    const streamAttempts: number[] = [];
    const sentMessages: string[] = [];
    const fetchImplementation = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/stream/open')) {
        streamAttempts.push(Date.now());
        if (streamAttempts.length === 1) {
          throw new Error('temporary disconnect');
        }
        return createOpenStreamResponse();
      }
      sentMessages.push(String(init?.body));
      return { ok: true } as Response;
    });
    const transport = evaluateRuntimeTransport(
      createWebpackRuntimeClientSource(createWdsOptions()),
      fetchImplementation,
      FakeWebSocket,
    );

    try {
      for (let index = 0; index < 100; index += 1) {
        transport.send('wsi:test', { pageClientId: 'page-1', index });
      }
      await flushPromises();
      expect(streamAttempts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(250);
      await flushPromises();

      expect(streamAttempts).toHaveLength(2);
      expect(sentMessages).toHaveLength(64);
    } finally {
      transport.dispose();
      vi.useRealTimers();
    }
  });

  it('WDS dispose 会取消已安排的重连', async () => {
    vi.useFakeTimers();
    let streamAttempts = 0;
    const fetchImplementation = vi.fn(async () => {
      streamAttempts += 1;
      throw new Error('offline');
    });
    const transport = evaluateRuntimeTransport(
      createWebpackRuntimeClientSource(createWdsOptions()),
      fetchImplementation,
      FakeWebSocket,
    );

    try {
      transport.send('wsi:test', { pageClientId: 'page-1' });
      await flushPromises();
      expect(streamAttempts).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      transport.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(streamAttempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('raw socket 断线后清理旧状态、退避重连，并限制待发消息数量', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    const transport = evaluateRuntimeTransport(
      createWebpackRuntimeClientSource(createRawOptions()),
      vi.fn(),
      FakeWebSocket,
    );

    try {
      for (let index = 0; index < 100; index += 1) {
        transport.send('wsi:test', { pageClientId: 'page-1', index });
      }
      const firstSocket = FakeWebSocket.instances[0];
      expect(firstSocket).toBeDefined();
      firstSocket?.open();
      expect(firstSocket?.sent).toHaveLength(64);

      firstSocket?.disconnect();
      await vi.advanceTimersByTimeAsync(250);
      expect(FakeWebSocket.instances).toHaveLength(2);

      transport.dispose();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createWdsOptions(): WsiRuntimeBootstrapOptions {
  return {
    sessionId: 'session-1',
    sessionEpoch: 'epoch-1',
    browserToken: 'token-1',
    runtimeModuleRequest: '@web-source-inspector/runtime',
    transport: { kind: 'wds', basePath: '/__wsi/test' },
  };
}

function createRawOptions(): WsiRuntimeBootstrapOptions {
  return {
    sessionId: 'session-1',
    sessionEpoch: 'epoch-1',
    browserToken: 'token-1',
    runtimeModuleRequest: '@web-source-inspector/runtime',
    transport: { kind: 'raw', port: 41731, path: '/__wsi/raw/test' },
  };
}

function evaluateRuntimeTransport(
  source: string,
  fetchImplementation: unknown,
  webSocketImplementation: typeof FakeWebSocket,
): RuntimeTransport {
  let transport: RuntimeTransport | null = null;
  const createInspectorRuntime = (options: { transport: RuntimeTransport }) => {
    transport = options.transport;
    return { dispose: () => options.transport.dispose() };
  };
  const executableSource = source.replace(/^\s*import[^;]+;\s*/u, '');
  const execute = new Function(
    'createInspectorRuntime',
    'globalThis',
    'fetch',
    'crypto',
    'AbortController',
    'TextDecoder',
    'WebSocket',
    `${executableSource}\nreturn globalThis[${JSON.stringify(WEBPACK_RUNTIME_GUARD)}];`,
  );
  execute(
    createInspectorRuntime,
    {},
    fetchImplementation,
    { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) },
    AbortController,
    TextDecoder,
    webSocketImplementation,
  );
  if (!transport) {
    throw new Error('runtime transport 未创建');
  }
  return transport;
}

function createOpenStreamResponse(): Response {
  return {
    ok: true,
    body: {
      getReader() {
        return { read: () => new Promise<never>(() => undefined) };
      },
    },
  } as unknown as Response;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
