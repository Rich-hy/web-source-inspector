import { findSourceCandidate, isShortcut } from './dom';
import { PROTOCOL_VERSION } from '@web-source-inspector/protocol';
import * as browserProtocol from '@web-source-inspector/protocol';
import type {
  ServerToBrowserEvent,
  ServerToBrowserPayloadMap
} from '@web-source-inspector/protocol';
import { browserEvents, RUNTIME_VERSION } from './events';
import type {
  BrowserHelloPayload,
  BrowserPageSummary,
  BrowserResultPayload,
  BrowserSelectionPayload,
  ConnectionState,
  InspectorMode,
  InspectorRuntime,
  InspectorRuntimeOptions,
  RuntimeDisposeReason,
  RuntimeHitTester,
  SourceCandidate
} from './types';
import { COMPONENT_SOURCE_ATTRIBUTE, SOURCE_ATTRIBUTE } from './types';
import { createInspectorView } from './view';

const BROWSER_TOKEN_AUDIENCE = 'browser-transport' as const;
const BROWSER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,512}$/;
// 兼容尚未重建的 protocol dist；统一包发布后可移除旧 Vite 名称回退。
const validateServerToBrowserPayload = browserProtocol.validateServerToBrowserPayload
  ?? browserProtocol.validateViteToBrowserPayload;

function readServerPayload<TEvent extends ServerToBrowserEvent>(
  event: TEvent,
  payload: unknown
): ServerToBrowserPayloadMap[TEvent] | null {
  const validation = validateServerToBrowserPayload(event, payload);
  return validation.ok ? validation.value : null;
}

function createPageClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createSelectionRequestId(): string {
  return `request_${createPageClientId()}`;
}

function getPageSummary(): BrowserPageSummary {
  return {
    origin: window.location.origin,
    pathname: window.location.pathname,
    title: document.title.slice(0, 160)
  };
}

function resultMessage(payload: BrowserResultPayload, language: 'zh-CN' | 'en-US'): string {
  if (payload.ok) {
    return language === 'zh-CN' ? '已在 IDE 打开' : 'Opened in IDE';
  }
  if (payload.message) {
    return payload.message;
  }
  const labels: Record<string, [string, string]> = {
    IDE_NOT_CONNECTED: ['IDE 未连接', 'IDE is not connected'],
    IDE_SELECTION_REQUIRED: ['请选择目标 IDE', 'Choose a target IDE'],
    SOURCE_STALE: ['页面源码已更新，请刷新后重试', 'Source changed; refresh and retry'],
    SOURCE_NOT_FOUND: ['未找到源码记录', 'Source record was not found'],
    RATE_LIMITED: ['操作过于频繁', 'Too many requests'],
    TARGET_UNSUPPORTED: ['该目标暂不支持定位', 'This target is not supported']
  };
  const label = labels[payload.code || ''];
  return label ? label[language === 'zh-CN' ? 0 : 1] : (language === 'zh-CN' ? '无法打开源码' : 'Unable to open source');
}

export function createInspectorRuntime(options: InspectorRuntimeOptions): InspectorRuntime {
  if (!BROWSER_TOKEN_PATTERN.test(options.browserToken)) {
    throw new TypeError('browserToken 格式无效');
  }
  const attributeName = options.attributeName || SOURCE_ATTRIBUTE;
  const componentAttributeName = options.componentAttributeName || COMPONENT_SOURCE_ATTRIBUTE;
  const language = options.language || 'zh-CN';
  const shortcut = options.shortcut === undefined ? 'Alt+Shift+C' : options.shortcut;
  const singleShot = options.singleShot ?? true;
  const metadataDelayMs = options.metadataDelayMs ?? 90;
  const pageClientId = createPageClientId();
  const view = createInspectorView(options.buttonPosition || 'bottom-right', language);
  const originalCursor = document.documentElement.style.cursor;
  const hitTesters = new Set<RuntimeHitTester>();
  const unsubscribe: Array<() => void> = [];
  let mode: InspectorMode = 'disabled';
  let connection: ConnectionState = 'disconnected';
  let currentCandidate: SourceCandidate | null = null;
  let pendingPointerEvent: PointerEvent | null = null;
  let frameId = 0;
  let metadataTimer: ReturnType<typeof setTimeout> | undefined;
  let openingTimer: ReturnType<typeof setTimeout> | undefined;
  let helloTimer: ReturnType<typeof setInterval> | undefined;
  let pendingSelectionRequestId: string | null = null;
  let disposed = false;

  function createBrowserContext() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: options.sessionId,
      pageClientId,
      timestamp: Date.now(),
      browserToken: options.browserToken,
      tokenAudience: BROWSER_TOKEN_AUDIENCE
    };
  }

  function setMode(nextMode: InspectorMode): void {
    if (nextMode !== 'opening') {
      pendingSelectionRequestId = null;
      if (openingTimer) {
        clearTimeout(openingTimer);
        openingTimer = undefined;
      }
    }
    mode = nextMode;
    view.setMode(mode);
    document.documentElement.style.cursor = mode === 'armed' ? 'crosshair' : originalCursor;
    if (mode !== 'armed') {
      pendingPointerEvent = null;
      if (frameId) {
        cancelAnimationFrame(frameId);
        frameId = 0;
      }
      if (metadataTimer) {
        clearTimeout(metadataTimer);
        metadataTimer = undefined;
      }
    }
    if (mode === 'disabled') {
      currentCandidate = null;
      view.clearCandidate();
    }
  }

  function setConnection(nextConnection: ConnectionState, ideName?: string): void {
    connection = nextConnection;
    view.setConnection(connection, ideName);
  }

  function resolveCandidate(event: PointerEvent): SourceCandidate | null {
    for (const hitTester of hitTesters) {
      const candidate = hitTester.hitTest(event);
      if (candidate) {
        return candidate;
      }
    }
    return findSourceCandidate(event, attributeName, view.host, componentAttributeName);
  }

  function requestMetadata(candidate: SourceCandidate): void {
    if (metadataTimer) {
      clearTimeout(metadataTimer);
    }
    metadataTimer = setTimeout(() => {
      metadataTimer = undefined;
      options.transport.send(browserEvents.metadataRequest, {
        ...createBrowserContext(),
        sourceId: candidate.sourceId
      });
    }, metadataDelayMs);
  }

  function updateHover(event: PointerEvent): void {
    const candidate = resolveCandidate(event);
    if (!candidate) {
      currentCandidate = null;
      view.clearCandidate();
      return;
    }

    const changed = candidate.sourceId !== currentCandidate?.sourceId || candidate.element !== currentCandidate.element;
    currentCandidate = candidate;
    view.showCandidate(candidate);
    if (changed) {
      requestMetadata(candidate);
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (mode !== 'armed') {
      return;
    }
    pendingPointerEvent = event;
    if (frameId) {
      return;
    }
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      if (pendingPointerEvent && mode === 'armed') {
        updateHover(pendingPointerEvent);
      }
      pendingPointerEvent = null;
    });
  }

  function shouldIgnore(event: Event): boolean {
    return event.composedPath().includes(view.host);
  }

  function blockBusinessEvent(event: Event): void {
    if (shouldIgnore(event)) {
      // Inspector 自身交互也需在捕获阶段隔离，避免触发页面级 pointer/drag 监听。
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (mode === 'disabled') {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClick(event: MouseEvent): void {
    if (shouldIgnore(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      mode === 'disabled' ? setMode('armed') : setMode('disabled');
      return;
    }
    if (mode === 'disabled') {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (mode !== 'armed') {
      return;
    }

    const candidate = resolveCandidate(event as PointerEvent);
    if (!candidate) {
      view.showMessage(language === 'zh-CN' ? '该元素没有可用源码位置' : 'No source location for this element');
      return;
    }

    const requestId = createSelectionRequestId();
    pendingSelectionRequestId = requestId;
    setMode('opening');
    const payload: BrowserSelectionPayload = {
      ...createBrowserContext(),
      sourceId: candidate.sourceId,
      candidateKind: candidate.kind,
      modifiers: { shift: event.shiftKey, alt: event.altKey },
      page: getPageSummary(),
      requestId
    };
    options.transport.send(browserEvents.select, payload);
    openingTimer = setTimeout(() => {
      if (mode === 'opening' && pendingSelectionRequestId === requestId) {
        setMode('armed');
        view.showMessage(language === 'zh-CN' ? 'IDE 响应超时' : 'IDE response timed out');
      }
    }, 8_000);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && mode !== 'disabled') {
      event.preventDefault();
      setMode('disabled');
      return;
    }
    if (shortcut && isShortcut(event, shortcut)) {
      event.preventDefault();
      mode === 'disabled' ? setMode('armed') : setMode('disabled');
    }
  }

  function handleConnection(rawPayload: unknown): void {
    const payload = readServerPayload(browserEvents.connection, rawPayload);
    if (!payload) {
      return;
    }
    if (payload.pageClientId !== pageClientId || payload.sessionId !== options.sessionId) {
      return;
    }
    setConnection(payload.connected ? 'connected' : 'disconnected', payload.ideName);
    if (payload.message) {
      view.showMessage(payload.message);
    }
  }

  function handleMetadata(rawPayload: unknown): void {
    const payload = readServerPayload(browserEvents.metadata, rawPayload);
    if (!payload) {
      return;
    }
    if (payload.pageClientId !== pageClientId
      || payload.sessionId !== options.sessionId
      || payload.sourceId !== currentCandidate?.sourceId) {
      return;
    }
    view.showMetadata(payload);
  }

  function handleResult(rawPayload: unknown): void {
    const payload = readServerPayload(browserEvents.result, rawPayload);
    if (!payload) {
      return;
    }
    if (payload.pageClientId !== pageClientId || payload.sessionId !== options.sessionId) {
      return;
    }
    if (!pendingSelectionRequestId || payload.requestId !== pendingSelectionRequestId) {
      return;
    }
    if (openingTimer) {
      clearTimeout(openingTimer);
      openingTimer = undefined;
    }
    if (payload.code === 'SOURCE_STALE') {
      setConnection('stale');
    } else if (!payload.ok && payload.code === 'INTERNAL_ERROR') {
      setConnection('error');
    }
    view.showMessage(resultMessage(payload, language));
    setMode(payload.ok && singleShot ? 'disabled' : 'armed');
  }

  function handleSetMode(rawPayload: unknown): void {
    const payload = readServerPayload(browserEvents.setMode, rawPayload);
    if (!payload) {
      return;
    }
    if (payload.pageClientId !== pageClientId || payload.sessionId !== options.sessionId) {
      return;
    }
    setMode(payload.enabled ? 'armed' : 'disabled');
  }

  function announce(): void {
    const hello: BrowserHelloPayload = {
      ...createBrowserContext(),
      runtimeVersion: RUNTIME_VERSION,
      capabilities: ['metadata', 'candidate-kind', 'remote-toggle'],
      page: getPageSummary()
    };
    options.transport.send(browserEvents.hello, hello);
  }

  function dispose(reason: RuntimeDisposeReason): void {
    if (disposed) {
      return;
    }
    disposed = true;
    try {
      options.transport.send(browserEvents.dispose, {
        ...createBrowserContext(),
        reason
      });
    } catch {
      // unload/HMR 清理不能被已断开的 transport 中断。
    }
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerdown', blockBusinessEvent, true);
    document.removeEventListener('pointerup', blockBusinessEvent, true);
    document.removeEventListener('mousedown', blockBusinessEvent, true);
    document.removeEventListener('mouseup', blockBusinessEvent, true);
    document.removeEventListener('touchstart', blockBusinessEvent, true);
    document.removeEventListener('touchend', blockBusinessEvent, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('dblclick', blockBusinessEvent, true);
    document.removeEventListener('contextmenu', blockBusinessEvent, true);
    document.removeEventListener('dragstart', blockBusinessEvent, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('beforeunload', onBeforeUnload);
    unsubscribe.forEach((stop) => stop());
    unsubscribe.length = 0;
    hitTesters.clear();
    if (frameId) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
    if (metadataTimer) {
      clearTimeout(metadataTimer);
      metadataTimer = undefined;
    }
    if (openingTimer) {
      clearTimeout(openingTimer);
    }
    pendingSelectionRequestId = null;
    if (helloTimer) {
      clearInterval(helloTimer);
      helloTimer = undefined;
    }
    document.documentElement.style.cursor = originalCursor;
    view.dispose();
    try {
      // 兼容尚未升级的运行时 transport 实现。
      options.transport.dispose?.();
    } catch {
      // transport 已不可用时，其余 Runtime 资源仍已完成释放。
    }
  }

  function onBeforeUnload(): void {
    dispose('unload');
  }

  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerdown', blockBusinessEvent, true);
  document.addEventListener('pointerup', blockBusinessEvent, true);
  document.addEventListener('mousedown', blockBusinessEvent, true);
  document.addEventListener('mouseup', blockBusinessEvent, true);
  document.addEventListener('touchstart', blockBusinessEvent, true);
  document.addEventListener('touchend', blockBusinessEvent, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('dblclick', blockBusinessEvent, true);
  document.addEventListener('contextmenu', blockBusinessEvent, true);
  document.addEventListener('dragstart', blockBusinessEvent, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('beforeunload', onBeforeUnload);
  unsubscribe.push(
    options.transport.on(browserEvents.connection, handleConnection),
    options.transport.on(browserEvents.metadata, handleMetadata),
    options.transport.on(browserEvents.result, handleResult),
    options.transport.on(browserEvents.setMode, handleSetMode)
  );
  announce();
  helloTimer = setInterval(announce, 30_000);

  return {
    pageClientId,
    get mode() {
      return mode;
    },
    enable: () => {
      if (!disposed) {
        setMode('armed');
      }
    },
    disable: () => {
      if (!disposed) {
        setMode('disabled');
      }
    },
    toggle: () => {
      if (!disposed) {
        mode === 'disabled' ? setMode('armed') : setMode('disabled');
      }
    },
    registerHitTester(hitTester) {
      if (disposed) {
        return () => undefined;
      }
      hitTesters.add(hitTester);
      return () => hitTesters.delete(hitTester);
    },
    dispose: (reason = 'manual') => dispose(reason)
  };
}
