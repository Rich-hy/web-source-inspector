export const WEBPACK_RUNTIME_GUARD = '__WEB_SOURCE_INSPECTOR_WEBPACK_RUNTIME__';

import type { WsiRuntimeBootstrapOptions } from './types.js';

/** 多 entry 只能执行一次 Runtime bootstrap。 */
export function createRuntimeBootstrapSource(runtimeModuleRequest: string): string {
  return [
    `const scope = globalThis;`,
    `if (!scope.${WEBPACK_RUNTIME_GUARD}) {`,
    `  scope.${WEBPACK_RUNTIME_GUARD} = true;`,
    `  import(${JSON.stringify(runtimeModuleRequest)});`,
    `}`,
  ].join('\n');
}

/** 生成同源 POST stream BrowserTransport，并由 global guard 避免多 entry 重复挂载。 */
export function createWebpackRuntimeClientSource(options: WsiRuntimeBootstrapOptions): string {
  return options.transport.kind === 'raw'
    ? createRawRuntimeClientSource(options)
    : createWdsRuntimeClientSource(options);
}

function createWdsRuntimeClientSource(options: WsiRuntimeBootstrapOptions): string {
  const serializedOptions = JSON.stringify(options);
  return `
import { createInspectorRuntime } from ${JSON.stringify(options.runtimeModuleRequest)};

const globalKey = ${JSON.stringify(WEBPACK_RUNTIME_GUARD)};
if (!globalThis[globalKey]) {
  const config = ${serializedOptions};
  const listeners = new Map();
  const pendingMessages = [];
  const maximumPendingMessages = 64;
  const reconnectBaseDelay = 250;
  const reconnectMaximumDelay = 5000;
  let disposed = false;
  let pageClientId = null;
  let connectionId = null;
  let connectionPromise = null;
  let connectionOpen = false;
  let connectionGeneration = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let streamController = null;
  let messageController = null;
  let flushPromise = null;

  const createConnectionId = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const headers = (includeContentType) => {
    const values = {
      Authorization: 'Bearer ' + config.browserToken,
      'X-WSI-Page-Client-Id': pageClientId,
      'X-WSI-Connection-Id': connectionId
    };
    if (includeContentType) {
      values['Content-Type'] = 'application/json';
    }
    return values;
  };
  const dispatch = (event, payload) => {
    const eventListeners = listeners.get(event);
    if (!eventListeners) return;
    for (const listener of eventListeners) {
      listener(payload);
    }
  };
  const enqueueMessage = (message, front) => {
    if (pendingMessages.length >= maximumPendingMessages) {
      if (front) {
        pendingMessages.pop();
      } else {
        pendingMessages.shift();
      }
    }
    if (front) {
      pendingMessages.unshift(message);
    } else {
      pendingMessages.push(message);
    }
  };
  const readStream = async (response, generation) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (!disposed && generation === connectionGeneration) {
      const result = await reader.read();
      if (result.done) {
        throw new Error('WSI_STREAM_CLOSED');
      }
      pending += decoder.decode(result.value, { stream: true });
      const lines = pending.split('\\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        const envelope = JSON.parse(line);
        if (envelope && typeof envelope.event === 'string') {
          dispatch(envelope.event, envelope.payload);
        }
      }
    }
  };
  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null || !pageClientId) return;
    const delay = Math.min(
      reconnectMaximumDelay,
      reconnectBaseDelay * Math.pow(2, Math.min(reconnectAttempts, 5))
    );
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureConnection();
    }, delay);
  };
  const handleDisconnected = (generation) => {
    if (disposed || generation !== connectionGeneration) return;
    connectionGeneration += 1;
    connectionOpen = false;
    connectionPromise = null;
    connectionId = null;
    if (streamController) {
      streamController.abort();
      streamController = null;
    }
    if (messageController) {
      messageController.abort();
      messageController = null;
    }
    scheduleReconnect();
  };
  const flushMessages = (generation) => {
    if (flushPromise || disposed || !connectionOpen || generation !== connectionGeneration) {
      return;
    }
    flushPromise = (async () => {
      while (
        !disposed &&
        connectionOpen &&
        generation === connectionGeneration &&
        pendingMessages.length > 0
      ) {
        const message = pendingMessages.shift();
        const controller = new AbortController();
        messageController = controller;
        try {
          const response = await fetch(config.transport.basePath + '/message', {
            method: 'POST',
            headers: headers(true),
            body: message,
            cache: 'no-store',
            redirect: 'error',
            signal: controller.signal
          });
          if (!response.ok || generation !== connectionGeneration) {
            throw new Error('WSI_MESSAGE_SEND_FAILED');
          }
        } catch (error) {
          if (!disposed && generation === connectionGeneration) {
            enqueueMessage(message, true);
            handleDisconnected(generation);
          }
          break;
        } finally {
          if (messageController === controller) {
            messageController = null;
          }
        }
      }
    })().then(() => {
      flushPromise = null;
      if (
        !disposed &&
        connectionOpen &&
        generation === connectionGeneration &&
        pendingMessages.length > 0
      ) {
        flushMessages(generation);
      }
    });
  };
  const ensureConnection = () => {
    if (disposed || !pageClientId || connectionPromise) return;
    clearReconnectTimer();
    connectionGeneration += 1;
    const generation = connectionGeneration;
    connectionId = createConnectionId();
    const controller = new AbortController();
    streamController = controller;
    connectionPromise = fetch(config.transport.basePath + '/stream/open', {
      method: 'POST',
      headers: headers(false),
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal
    }).then((response) => {
      if (!response.ok || !response.body) {
        throw new Error('WSI_STREAM_OPEN_FAILED');
      }
      if (disposed || generation !== connectionGeneration) return;
      connectionOpen = true;
      reconnectAttempts = 0;
      flushMessages(generation);
      readStream(response, generation).then(
        () => handleDisconnected(generation),
        () => handleDisconnected(generation)
      );
    });
    connectionPromise.catch(() => handleDisconnected(generation));
  };
  const acceptPageClient = (payload) => {
    const nextPageClientId = payload && typeof payload.pageClientId === 'string'
      ? payload.pageClientId
      : null;
    if (!nextPageClientId) return false;
    if (pageClientId && pageClientId !== nextPageClientId) {
      return false;
    }
    pageClientId = nextPageClientId;
    return true;
  };
  const transport = {
    send(event, payload) {
      if (disposed) return;
      if (!acceptPageClient(payload)) return;
      enqueueMessage(JSON.stringify({ event, payload }), false);
      ensureConnection();
      if (connectionOpen) {
        flushMessages(connectionGeneration);
      }
    },
    on(event, listener) {
      const eventListeners = listeners.get(event) || new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearReconnectTimer();
      connectionGeneration += 1;
      pendingMessages.length = 0;
      listeners.clear();
      if (streamController) {
        streamController.abort();
        streamController = null;
      }
      if (messageController) {
        messageController.abort();
        messageController = null;
      }
      connectionPromise = null;
      connectionOpen = false;
      connectionId = null;
    }
  };
  const runtime = createInspectorRuntime({
    sessionId: config.sessionId,
    browserToken: config.browserToken,
    transport
  });
  globalThis[globalKey] = runtime;
}
`;
}

function createRawRuntimeClientSource(options: WsiRuntimeBootstrapOptions): string {
  const serializedOptions = JSON.stringify(options);
  return `
import { createInspectorRuntime } from ${JSON.stringify(options.runtimeModuleRequest)};

const globalKey = ${JSON.stringify(WEBPACK_RUNTIME_GUARD)};
if (!globalThis[globalKey]) {
  const config = ${serializedOptions};
  const listeners = new Map();
  const pendingMessages = [];
  const maximumPendingMessages = 64;
  const reconnectBaseDelay = 250;
  const reconnectMaximumDelay = 5000;
  let disposed = false;
  let pageClientId = null;
  let socket = null;
  let socketGeneration = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  const dispatch = (event, payload) => {
    const eventListeners = listeners.get(event);
    if (!eventListeners) return;
    for (const listener of eventListeners) {
      listener(payload);
    }
  };
  const enqueueMessage = (message) => {
    if (pendingMessages.length >= maximumPendingMessages) {
      pendingMessages.shift();
    }
    pendingMessages.push(message);
  };
  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null || !pageClientId) return;
    const delay = Math.min(
      reconnectMaximumDelay,
      reconnectBaseDelay * Math.pow(2, Math.min(reconnectAttempts, 5))
    );
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureSocket();
    }, delay);
  };
  const acceptPageClient = (payload) => {
    const nextPageClientId = payload && typeof payload.pageClientId === 'string'
      ? payload.pageClientId
      : null;
    if (!nextPageClientId) return false;
    if (pageClientId && pageClientId !== nextPageClientId) {
      return false;
    }
    pageClientId = nextPageClientId;
    return true;
  };
  const ensureSocket = () => {
    if (disposed || !pageClientId) return null;
    if (
      socket &&
      (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
    ) {
      return socket;
    }
    clearReconnectTimer();
    socketGeneration += 1;
    const generation = socketGeneration;
    const url = 'ws://127.0.0.1:' + config.transport.port + config.transport.path
      + '?pageClientId=' + encodeURIComponent(pageClientId);
    let activeSocket;
    try {
      activeSocket = new WebSocket(url, ['wsi-browser-v1', 'wsi-token.' + config.browserToken]);
    } catch (error) {
      socket = null;
      scheduleReconnect();
      return null;
    }
    socket = activeSocket;
    activeSocket.addEventListener('open', () => {
      if (disposed || socket !== activeSocket || generation !== socketGeneration) {
        activeSocket.close(1000, 'STALE_SOCKET');
        return;
      }
      reconnectAttempts = 0;
      while (pendingMessages.length > 0 && activeSocket.readyState === WebSocket.OPEN) {
        activeSocket.send(pendingMessages.shift());
      }
    });
    activeSocket.addEventListener('message', (message) => {
      try {
        const envelope = JSON.parse(String(message.data));
        if (envelope && typeof envelope.event === 'string') {
          dispatch(envelope.event, envelope.payload);
        }
      } catch (error) {
        activeSocket.close(1008, 'INVALID_MESSAGE');
      }
    });
    activeSocket.addEventListener('error', () => {
      if (activeSocket.readyState !== WebSocket.CLOSED) {
        activeSocket.close(1011, 'SOCKET_ERROR');
      }
    });
    activeSocket.addEventListener('close', () => {
      if (socket !== activeSocket || generation !== socketGeneration) return;
      socket = null;
      scheduleReconnect();
    });
    return activeSocket;
  };
  const transport = {
    send(event, payload) {
      if (disposed) return;
      if (!acceptPageClient(payload)) return;
      const activeSocket = ensureSocket();
      const serialized = JSON.stringify({ event, payload });
      if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
        activeSocket.send(serialized);
      } else {
        enqueueMessage(serialized);
      }
    },
    on(event, listener) {
      const eventListeners = listeners.get(event) || new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearReconnectTimer();
      socketGeneration += 1;
      pendingMessages.length = 0;
      listeners.clear();
      if (socket) {
        socket.close(1000, 'RUNTIME_DISPOSED');
      }
      socket = null;
    }
  };
  const runtime = createInspectorRuntime({
    sessionId: config.sessionId,
    browserToken: config.browserToken,
    transport
  });
  globalThis[globalKey] = runtime;
}
`;
}
