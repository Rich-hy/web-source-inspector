import type {
  BROWSER_TOKEN_AUDIENCE,
  CLI_JSON_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION
} from './constants';

export type ProtocolVersion = `${number}.${number}`;

export type ProtocolErrorCode =
  | 'PROTOCOL_MISMATCH'
  | 'AUTH_FAILED'
  | 'IDE_NOT_CONNECTED'
  | 'IDE_NOT_CLAIMED'
  | 'IDE_SELECTION_REQUIRED'
  | 'IDE_REQUEST_TIMEOUT'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_STALE'
  | 'WORKSPACE_NOT_MATCHED'
  | 'PATH_REJECTED'
  | 'FILE_NOT_FOUND'
  | 'RANGE_ADJUSTED'
  | 'RANGE_STALE'
  | 'TARGET_UNSUPPORTED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'INVALID_MESSAGE'
  | 'MESSAGE_TOO_LARGE'
  | 'UNKNOWN_MESSAGE_TYPE'
  | 'SESSION_NOT_FOUND'
  | 'CLIENT_NOT_REGISTERED'
  | 'UNKNOWN_REQUEST'
  | 'INVALID_IDE_HELLO'
  | 'REPLAY_CONFLICT'
  | 'REQUEST_TIMEOUT'
  | 'PLAN_CONTEXT_REQUIRED'
  | 'PLAN_STALE'
  | 'RECOVERY_REQUIRED'
  | 'TRANSACTION_CONFLICT'
  | 'TEMPLATE_PIPELINE_MISMATCH'
  | 'MULTI_COMPILER_UNSUPPORTED'
  | 'WDS_TRANSPORT_UNSUPPORTED'
  | 'SOURCE_ID_COLLISION'
  | 'BUILD_SUPERSEDED';

/** 协议坐标为 1-based 行列、UTF-16 offset 和 [start, end) 范围。 */
export interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startOffset: number;
  endOffset: number;
}

export type SourceAccuracy = 'exact' | 'approximate';

export type CandidateKind =
  | 'element'
  | 'component'
  | 'call-site'
  | 'control-flow'
  | 'dynamic'
  | 'three';

export interface BrowserPageDescriptor {
  origin: string;
  pathname: string;
  title: string;
}

export interface BrowserModifiers {
  shift: boolean;
  alt: boolean;
}

export type BrowserTokenAudience = typeof BROWSER_TOKEN_AUDIENCE;

/** 服务端保存的 browser-scoped token 绑定，不得复用于 IDE Bridge。 */
export interface BrowserTokenBinding {
  audience: BrowserTokenAudience;
  sessionId: string;
  pageClientId: string;
  connectionId: string;
  issuedAt: number;
  expiresAt: number;
}

/** Adapter 交给中央安全校验的传输层握手事实。 */
export interface BrowserTransportValidationInput {
  token: string;
  audience: BrowserTokenAudience;
  sessionId: string;
  pageClientId: string;
  connectionId: string;
  timestamp: number;
  remoteAddress: string | null;
  origin: string | null;
  host: string | null;
  protocol: 'http:' | 'https:' | null;
  allowedOrigins: readonly string[];
}

export interface BrowserClientContext {
  protocolVersion: ProtocolVersion;
  sessionId: string;
  pageClientId: string;
  timestamp: number;
  browserToken: string;
  tokenAudience: BrowserTokenAudience;
}

export interface BrowserHelloPayload extends BrowserClientContext {
  runtimeVersion: string;
  capabilities: string[];
  page: BrowserPageDescriptor;
}

export interface BrowserHeartbeatPayload extends BrowserClientContext {
  sequence: number;
}

export interface BrowserSelectPayload extends BrowserClientContext {
  sourceId: string;
  candidateKind: CandidateKind;
  modifiers: BrowserModifiers;
  page: BrowserPageDescriptor;
  requestId?: string;
}

export interface BrowserMetadataRequestPayload extends BrowserClientContext {
  sourceId: string;
  requestId?: string;
}

export interface BrowserDisposePayload extends BrowserClientContext {
  reason: 'unload' | 'hmr' | 'manual';
}

export interface ServerBrowserContext {
  protocolVersion: ProtocolVersion;
  sessionId: string;
  pageClientId: string;
  timestamp: number;
}

export interface ServerSetModePayload extends ServerBrowserContext {
  enabled: boolean;
  mode?: 'once' | 'continuous';
}

export interface ServerConnectionPayload extends ServerBrowserContext {
  connected: boolean;
  ideName?: string;
  message?: string;
}

export interface ServerHeartbeatPayload extends ServerBrowserContext {
  sequence: number;
  acknowledged: true;
  serverTime: number;
}

/** Browser metadata 不包含路径、范围、候选位置或源码上下文。 */
export interface ServerMetadataPayload extends ServerBrowserContext {
  sourceId: string;
  tagName: string;
  componentName?: string;
  controlFlow?: ControlFlowKind;
}

export type ControlFlowKind = 'for' | 'if' | 'else-if' | 'else';

/** IDE 打开结果仅向 Browser 返回状态，不回传服务端定位信息。 */
export interface ServerResultPayload extends ServerBrowserContext {
  ok: boolean;
  requestId?: string;
  code?: ProtocolErrorCode;
  message?: string;
}

export interface BrowserToServerPayloadMap {
  'wsi:browser:hello': BrowserHelloPayload;
  'wsi:browser:heartbeat': BrowserHeartbeatPayload;
  'wsi:browser:select': BrowserSelectPayload;
  'wsi:browser:metadata-request': BrowserMetadataRequestPayload;
  'wsi:browser:dispose': BrowserDisposePayload;
}

export interface ServerToBrowserPayloadMap {
  'wsi:server:heartbeat': ServerHeartbeatPayload;
  'wsi:browser:set-mode': ServerSetModePayload;
  'wsi:browser:connection': ServerConnectionPayload;
  'wsi:browser:metadata': ServerMetadataPayload;
  'wsi:browser:result': ServerResultPayload;
}

export type BrowserToServerEvent = keyof BrowserToServerPayloadMap;
export type ServerToBrowserEvent = keyof ServerToBrowserPayloadMap;

/** @deprecated 使用 bundler-neutral BrowserToServerPayloadMap。 */
export type BrowserToVitePayloadMap = BrowserToServerPayloadMap;
/** @deprecated 使用 bundler-neutral ServerToBrowserPayloadMap。 */
export type ViteToBrowserPayloadMap = ServerToBrowserPayloadMap;
/** @deprecated 使用 BrowserToServerEvent。 */
export type BrowserToViteEvent = BrowserToServerEvent;
/** @deprecated 使用 ServerToBrowserEvent。 */
export type ViteToBrowserEvent = ServerToBrowserEvent;
/** @deprecated 使用 ServerBrowserContext。 */
export type ViteBrowserContext = ServerBrowserContext;
/** @deprecated 使用 ServerSetModePayload。 */
export type ViteSetModePayload = ServerSetModePayload;
/** @deprecated 使用 ServerConnectionPayload。 */
export type ViteConnectionPayload = ServerConnectionPayload;
/** @deprecated 使用 ServerMetadataPayload。 */
export type ViteMetadataPayload = ServerMetadataPayload;
/** @deprecated 使用 ServerResultPayload。 */
export type ViteResultPayload = ServerResultPayload;

export interface SessionRootDescriptor {
  rootKey: string;
  canonicalPath: string;
  displayName: string;
}

export interface SessionDescriptor {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  protocolVersion: ProtocolVersion;
  sessionId: string;
  pid: number;
  port: number;
  bridgePath: string;
  token: string;
  createdAt: number;
  heartbeatAt: number;
  projectName: string;
  canonicalRoots: SessionRootDescriptor[];
  devOrigins: string[];
  capabilities: string[];
}

export type IdeKind = 'vscode' | 'cursor';

export interface BrowserTabDescriptor {
  pageClientId: string;
  pathname: string;
  title: string;
  connectedAt: number;
}

export interface BridgeSessionSummary {
  sessionId: string;
  projectName: string;
  canonicalRoots: Array<
    Pick<SessionRootDescriptor, 'rootKey' | 'displayName'>
  >;
  capabilities: string[];
}

export interface IdeWorkspaceRoot {
  rootKey?: string;
  canonicalPath: string;
}

export interface IdeHelloPayload {
  ideClientId: string;
  ideName: string;
  extensionVersion: string;
  workspaceRoots: IdeWorkspaceRoot[];
  capabilities: string[];
  focused: boolean;
}

export interface ServerHelloAckPayload {
  authenticated: true;
  session: BridgeSessionSummary;
  browserTabs: BrowserTabDescriptor[];
}

export interface IdeClaimPayload {
  claim: boolean;
}

export interface ServerClaimResultPayload {
  claimed: boolean;
}

export interface IdeFocusPayload {
  focused: boolean;
}

export interface HeartbeatPayload {
  acknowledged?: true;
  serverTime?: number;
}

export interface OpenSourceCandidate {
  candidateKind: CandidateKind;
  rootKey: string;
  relativePath: string;
  range: SourceRange;
  sourceDigest: string;
  contextBefore?: string | null;
  contextAfter?: string | null;
  accuracy: SourceAccuracy;
  label: string;
}

export interface OpenSourcePageContext {
  origin: string;
  pathname: string;
  title: string;
}

export interface ServerOpenSourcePayload {
  openRequestId: string;
  pageClientId: string;
  rootKey: string;
  relativePath: string;
  range: SourceRange;
  sourceDigest: string;
  contextBefore: string | null;
  contextAfter: string | null;
  accuracy: SourceAccuracy;
  candidateKind: string;
  tagName: string;
  componentName: string | null;
  candidates?: OpenSourceCandidate[];
  page: OpenSourcePageContext;
}

export interface IdeOpenResultPayload {
  requestMessageId: string;
  ok: boolean;
  accuracy?: SourceAccuracy;
  relativePath?: string;
  line?: number;
  code?: ProtocolErrorCode;
  message?: string;
}

export interface IdeSetBrowserModePayload {
  pageClientId?: string;
  enabled: boolean;
}

export interface ServerTabsChangedPayload {
  browserTabs: BrowserTabDescriptor[];
}

export interface ServerSessionDisposePayload {
  reason: 'dev-server-closed' | 'restart' | 'expired';
}

export interface ErrorPayload {
  code: ProtocolErrorCode;
  requestMessageId?: string;
  message?: string;
}

export interface BridgePayloadMap {
  'ide:hello': IdeHelloPayload;
  'server:hello-ack': ServerHelloAckPayload;
  'ide:claim': IdeClaimPayload;
  'server:claim-result': ServerClaimResultPayload;
  'ide:focus': IdeFocusPayload;
  heartbeat: HeartbeatPayload;
  'server:open-source': ServerOpenSourcePayload;
  'ide:open-result': IdeOpenResultPayload;
  'ide:set-browser-mode': IdeSetBrowserModePayload;
  'server:tabs-changed': ServerTabsChangedPayload;
  'server:session-dispose': ServerSessionDisposePayload;
  error: ErrorPayload;
}

export type BridgeMessageType = keyof BridgePayloadMap;

export interface ProtocolEnvelope<
  TType extends BridgeMessageType = BridgeMessageType,
  TPayload = BridgePayloadMap[TType]
> {
  protocolVersion: ProtocolVersion;
  messageId: string;
  type: TType;
  sessionId: string;
  senderId: string;
  timestamp: number;
  payload: TPayload;
}

export type BridgeMessage = {
  [TType in BridgeMessageType]: ProtocolEnvelope<
    TType,
    BridgePayloadMap[TType]
  >;
}[BridgeMessageType];

export type IdeToServerMessage = Extract<
  BridgeMessage,
  { type: 'ide:hello' | 'ide:claim' | 'ide:focus' | 'heartbeat' | 'ide:open-result' | 'ide:set-browser-mode' | 'error' }
>;

export type ServerToIdeMessage = Extract<
  BridgeMessage,
  { type: 'server:hello-ack' | 'server:claim-result' | 'heartbeat' | 'server:open-source' | 'server:tabs-changed' | 'server:session-dispose' | 'error' }
>;

export type CliJsonOperation =
  | 'init:plan'
  | 'init:apply'
  | 'doctor'
  | 'remove:plan'
  | 'remove:apply';

export type CliDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface CliJsonDiagnostic {
  code: string;
  severity: CliDiagnosticSeverity;
  message: string;
  file?: string;
}

/** CLI JSON 模式 stdout 的唯一顶层对象。 */
export interface CliJsonEnvelope<TResult = unknown> {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  protocolVersion: ProtocolVersion;
  operation: CliJsonOperation;
  ok: boolean;
  result: TResult | null;
  diagnostics: CliJsonDiagnostic[];
  errorCode: ProtocolErrorCode | null;
}

export interface ProtocolValidationIssue {
  code:
    | 'PROTOCOL_MISMATCH'
    | 'INVALID_MESSAGE'
    | 'MESSAGE_TOO_LARGE'
    | 'UNKNOWN_MESSAGE_TYPE';
  path: string;
  message: string;
}

export type ProtocolValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProtocolValidationIssue };
