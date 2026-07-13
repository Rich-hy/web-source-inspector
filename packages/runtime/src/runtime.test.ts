// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserEvents } from './events';
import { createInspectorRuntime } from './runtime';
import type { BrowserTransport, RuntimeTransport } from './types';

const browserToken = 'browser_token_runtime_1234567890abcdef1234567890abcdef';

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('InspectorRuntime lifecycle', () => {
  it('拒绝无效的 browser token，且不挂载 UI', () => {
    const transport: BrowserTransport = {
      send() {},
      on() {
        return () => undefined;
      },
      dispose() {}
    };

    expect(() => createInspectorRuntime({
      transport,
      sessionId: 'session_runtime_1234',
      browserToken: 'invalid'
    })).toThrow('browserToken 格式无效');
    expect(document.querySelector('[data-wsi-runtime-root="true"]')).toBeNull();
  });

  it('Inspector 按钮的 pointer 事件不会进入业务监听器', () => {
    const transport: RuntimeTransport = {
      send() {},
      on() {
        return () => undefined;
      },
      dispose() {}
    };
    const runtime = createInspectorRuntime({
      transport,
      sessionId: 'session_runtime_1234',
      browserToken
    });
    const host = document.querySelector<HTMLElement>('[data-wsi-runtime-root="true"]');
    const button = host?.shadowRoot?.querySelector<HTMLButtonElement>('button');
    let businessPointerDownCount = 0;
    const onBusinessPointerDown = (): void => {
      businessPointerDownCount += 1;
    };
    document.addEventListener('pointerdown', onBusinessPointerDown, true);

    expect(button).toBeTruthy();
    button?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));

    expect(businessPointerDownCount).toBe(0);
    document.removeEventListener('pointerdown', onBusinessPointerDown, true);
    runtime.dispose();
  });

  it('只处理当前选择请求对应的结果', () => {
    const sent: Array<[string, unknown]> = [];
    const listeners = new Map<string, (payload: unknown) => void>();
    const transport: RuntimeTransport = {
      send(event, payload) {
        sent.push([event, payload]);
      },
      on(event, listener) {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
      dispose() {}
    };
    const target = document.createElement('button');
    target.setAttribute('data-wsi-source', 'source_request_target_1234');
    document.body.append(target);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [target]
    });
    const runtime = createInspectorRuntime({
      transport,
      sessionId: 'session_runtime_1234',
      browserToken
    });

    runtime.enable();
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const firstRequest = [...sent].reverse().find(([event]) => event === browserEvents.select)?.[1] as {
      requestId?: string;
    };
    runtime.disable();
    runtime.enable();
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const secondRequest = [...sent].reverse().find(([event]) => event === browserEvents.select)?.[1] as {
      requestId?: string;
    };

    expect(firstRequest.requestId).toBeTruthy();
    expect(secondRequest.requestId).toBeTruthy();
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
    listeners.get(browserEvents.result)?.({
      protocolVersion: '1.0',
      sessionId: 'session_runtime_1234',
      pageClientId: runtime.pageClientId,
      timestamp: Date.now(),
      requestId: firstRequest.requestId,
      ok: true
    });
    expect(runtime.mode).toBe('opening');

    listeners.get(browserEvents.result)?.({
      protocolVersion: '1.0',
      sessionId: 'session_runtime_1234',
      pageClientId: runtime.pageClientId,
      timestamp: Date.now(),
      requestId: secondRequest.requestId,
      ok: 'invalid'
    });
    expect(runtime.mode).toBe('opening');

    listeners.get(browserEvents.result)?.({
      protocolVersion: '1.0',
      sessionId: 'session_runtime_1234',
      pageClientId: runtime.pageClientId,
      timestamp: Date.now(),
      requestId: secondRequest.requestId,
      ok: true
    });
    expect(runtime.mode).toBe('disabled');
    runtime.dispose();
  });

  it('结果返回后保持 hello 心跳，dispose 后停止', () => {
    vi.useFakeTimers();
    const sent: Array<[string, unknown]> = [];
    const listeners = new Map<string, (payload: unknown) => void>();
    const transport: RuntimeTransport = {
      send(event, payload) {
        sent.push([event, payload]);
      },
      on(event, listener) {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
      dispose() {}
    };
    const runtime = createInspectorRuntime({
      transport,
      sessionId: 'session_runtime_1234',
      browserToken
    });
    const helloCount = (): number => sent.filter(([event]) => event === browserEvents.hello).length;

    expect(helloCount()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(helloCount()).toBe(2);
    listeners.get(browserEvents.result)?.({
      protocolVersion: '1.0',
      sessionId: 'session_runtime_1234',
      pageClientId: runtime.pageClientId,
      timestamp: Date.now(),
      ok: false,
      code: 'IDE_NOT_CONNECTED'
    });
    vi.advanceTimersByTime(30_000);
    expect(helloCount()).toBe(3);

    runtime.dispose();
    const countAfterDispose = helloCount();
    vi.advanceTimersByTime(60_000);
    expect(helloCount()).toBe(countAfterDispose);
  });

  it('Esc 禁用后取消待处理的 hover metadata', () => {
    vi.useFakeTimers();
    const sent: Array<[string, unknown]> = [];
    const transport: BrowserTransport = {
      send(event, payload) {
        sent.push([event, payload]);
      },
      on() {
        return () => undefined;
      },
      dispose() {}
    };
    const target = document.createElement('button');
    target.setAttribute('data-wsi-source', 'source_hover_target_12345678901234567890');
    document.body.append(target);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [target]
    });
    const runtime = createInspectorRuntime({
      transport,
      sessionId: 'session_runtime_1234',
      browserToken
    });

    runtime.enable();
    target.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      composed: true,
      clientX: 10,
      clientY: 12
    }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    vi.advanceTimersByTime(200);

    expect(runtime.mode).toBe('disabled');
    expect(sent.some(([event]) => event === browserEvents.metadataRequest)).toBe(false);
    runtime.dispose();
  });

  it('dispose 幂等释放 transport 和所有订阅', () => {
    const stopListeners = Array.from({ length: 4 }, () => vi.fn());
    const transportDispose = vi.fn();
    const sent: Array<[string, unknown]> = [];
    let listenerIndex = 0;
    const transport: BrowserTransport = {
      send(event, payload) {
        sent.push([event, payload]);
      },
      on() {
        const stop = stopListeners[listenerIndex]!;
        listenerIndex += 1;
        return stop;
      },
      dispose: transportDispose
    };
    const runtime = createInspectorRuntime({
      transport,
      sessionId: 'session_runtime_1234',
      browserToken
    });

    runtime.dispose('hmr');
    runtime.dispose();

    expect(transportDispose).toHaveBeenCalledTimes(1);
    expect(stopListeners.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    expect(sent[0]?.[1]).toMatchObject({
      browserToken,
      tokenAudience: 'browser-transport',
      sessionId: 'session_runtime_1234'
    });
    const disposeEvents = sent.filter(([event]) => event === browserEvents.dispose);
    expect(disposeEvents).toHaveLength(1);
    expect(disposeEvents[0]?.[1]).toMatchObject({ reason: 'hmr' });
  });
});
