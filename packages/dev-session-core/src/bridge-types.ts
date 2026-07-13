import type {
  BrowserTabDescriptor,
  IdeHelloPayload,
  OpenSourceCandidate,
  ProtocolErrorCode,
  ServerOpenSourcePayload,
  SessionDescriptor,
  SourceAccuracy
} from '@web-source-inspector/protocol';

export type BrowserTabSummary = BrowserTabDescriptor;
export type BridgeSourceCandidate = OpenSourceCandidate;
export type BridgeOpenRequest = Omit<ServerOpenSourcePayload, 'openRequestId'> & {
  candidates: BridgeSourceCandidate[];
};

export interface BridgeOpenResult<TCode extends string = string> {
  openRequestId?: string;
  pageClientId: string;
  ok: boolean;
  code?: TCode;
  message?: string;
  relativePath?: string;
  line?: number;
  accuracy?: SourceAccuracy;
}

export interface BridgeConnectionState {
  connected: boolean;
  ideName?: string;
  ideClientId?: string;
}

export interface BridgeSetModeRequest {
  pageClientId?: string;
  enabled: boolean;
}

export interface LoopbackBridgeOptions {
  session: Omit<SessionDescriptor, 'port' | 'heartbeatAt'>;
  sessionDirectory: string;
  getBrowserTabs: () => BrowserTabSummary[];
  onOpenResult: (result: BridgeOpenResult<ProtocolErrorCode>) => void;
  onConnectionChange: (state: BridgeConnectionState) => void;
  onSetBrowserMode: (request: BridgeSetModeRequest) => void;
  onDiagnostics?: (message: string) => void;
}

export interface LoopbackBridge {
  readonly descriptor: SessionDescriptor;
  readonly descriptorPath: string;
  requestOpenSource(request: BridgeOpenRequest):
    | { accepted: true; messageId: string }
    | { accepted: false; code: ProtocolErrorCode };
  notifyTabsChanged(): void;
  dispose(): Promise<void>;
}

export interface IdeClientState {
  ideClientId: string;
  ideName: string;
  workspaceRoots: IdeHelloPayload['workspaceRoots'];
  capabilities: string[];
  focused: boolean;
  lastFocusAt: number;
  lastHeartbeatAt: number;
  authenticated: boolean;
}
