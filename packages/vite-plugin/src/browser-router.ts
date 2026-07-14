import {
  BrowserRouter as CoreBrowserRouter,
  browserEvents,
  type BrowserRouterOptions,
  type BrowserTransportClient,
  type BridgeConnectionState,
  type BridgeOpenResult,
  type BridgeSetModeRequest,
  type BrowserTabSummary,
  type LoopbackBridge,
} from '@web-source-inspector/dev-session-core';

export interface ViteBrowserClient {
  send(event: string, payload: unknown): void;
  socket?: {
    readyState?: number;
    remoteAddress?: string;
    _socket?: { remoteAddress?: string };
  };
  _socket?: { remoteAddress?: string };
}

function viteRemoteAddress(client: ViteBrowserClient): string | null {
  const candidates = [
    client.socket?._socket?.remoteAddress,
    client.socket?.remoteAddress,
    client._socket?.remoteAddress,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function viteClientIsOpen(client: ViteBrowserClient): boolean {
  const readyState = client.socket?.readyState;
  return readyState === undefined || readyState === 1;
}

/** 将 Vite 私有 client 形态隔离在 Adapter 边界。 */
export class BrowserRouter {
  readonly #router: CoreBrowserRouter;
  readonly #clients = new WeakMap<object, BrowserTransportClient>();

  constructor(options: BrowserRouterOptions) {
    this.#router = new CoreBrowserRouter(options);
  }

  setBridge(bridge: LoopbackBridge): void {
    this.#router.setBridge(bridge);
  }

  handleHello(payload: unknown, client: ViteBrowserClient): void {
    this.#router.handleHello(payload, this.toTransportClient(client));
  }

  handleHeartbeat(payload: unknown, client: ViteBrowserClient): void {
    this.#router.handleHeartbeat(payload, this.toTransportClient(client));
  }

  handleMetadataRequest(payload: unknown, client: ViteBrowserClient): void {
    this.#router.handleMetadataRequest(payload, this.toTransportClient(client));
  }

  handleSelection(payload: unknown, client: ViteBrowserClient): void {
    this.#router.handleSelection(payload, this.toTransportClient(client));
  }

  handleDispose(payload: unknown, client: ViteBrowserClient): void {
    this.#router.handleDispose(payload, this.toTransportClient(client));
  }

  updateConnection(state: BridgeConnectionState): void {
    this.#router.updateConnection(state);
  }

  sendResult(result: BridgeOpenResult & { requestId?: string }): void {
    this.#router.sendResult(result);
  }

  setBrowserMode(request: BridgeSetModeRequest): void {
    this.#router.setBrowserMode(request);
  }

  getTabs(): BrowserTabSummary[] {
    return this.#router.getTabs();
  }

  sweepStalePages(): void {
    this.#router.sweepStalePages();
  }

  dispose(): void {
    this.#router.dispose();
  }

  private toTransportClient(client: ViteBrowserClient): BrowserTransportClient {
    const existing = this.#clients.get(client as object);
    if (existing) {
      return existing;
    }
    const adapted: BrowserTransportClient = {
      send(event, payload) {
        client.send(event, payload);
      },
      get remoteAddress() {
        return viteRemoteAddress(client);
      },
      isOpen() {
        return viteClientIsOpen(client);
      },
    };
    this.#clients.set(client as object, adapted);
    return adapted;
  }
}

export { browserEvents };
export type { BrowserRouterOptions, BrowserTransportClient };
