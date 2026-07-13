export const SOURCE_ATTRIBUTE = 'data-wsi-source';
export const COMPONENT_SOURCE_ATTRIBUTE = 'data-wsi-component-source';

export type InspectorMode = 'disabled' | 'armed' | 'opening';
export type ConnectionState = 'connected' | 'disconnected' | 'stale' | 'error';
export type ButtonPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type RuntimeDisposeReason = 'unload' | 'hmr' | 'manual';

export interface BrowserTransport {
  send(event: string, payload: unknown): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
  dispose(): void;
}

/** @deprecated 请改用 BrowserTransport。 */
export type RuntimeTransport = BrowserTransport;

export interface InspectorRuntimeOptions {
  transport: BrowserTransport;
  sessionId: string;
  browserToken: string;
  attributeName?: string;
  componentAttributeName?: string;
  buttonPosition?: ButtonPosition;
  shortcut?: string | false;
  singleShot?: boolean;
  /** @deprecated Runtime 不再显示源码行列，此选项已无效果。 */
  showLineColumn?: boolean;
  language?: 'zh-CN' | 'en-US';
  metadataDelayMs?: number;
}

export type BrowserPageSummary = BrowserPageDescriptor;
export type BrowserHelloPayload = ProtocolBrowserHelloPayload;
export type BrowserSelectionPayload = BrowserSelectPayload;
export type BrowserMetadataPayload = ServerMetadataPayload;
export type BrowserConnectionPayload = ServerConnectionPayload;
export type BrowserResultPayload = ServerResultPayload;
export type BrowserModePayload = ServerSetModePayload;

export interface InspectorRuntime {
  readonly pageClientId: string;
  readonly mode: InspectorMode;
  enable(): void;
  disable(): void;
  toggle(): void;
  registerHitTester(hitTester: RuntimeHitTester): () => void;
  dispose(reason?: RuntimeDisposeReason): void;
}

export interface SourceCandidate {
  element: Element;
  sourceId: string;
  kind: 'element' | 'component' | 'dynamic';
}

export interface RuntimeHitTester {
  hitTest(event: PointerEvent): SourceCandidate | null;
}
import type {
  BrowserHelloPayload as ProtocolBrowserHelloPayload,
  BrowserPageDescriptor,
  BrowserSelectPayload,
  ServerConnectionPayload,
  ServerMetadataPayload,
  ServerResultPayload,
  ServerSetModePayload
} from '@web-source-inspector/protocol';
