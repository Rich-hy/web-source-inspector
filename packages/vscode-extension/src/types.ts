import type {
  OpenSourceCandidate,
  ServerOpenSourcePayload as ProtocolServerOpenSourcePayload,
  SourceAccuracy,
  SourceRange,
} from '@web-source-inspector/protocol';

export { BRIDGE_SUBPROTOCOL, PROTOCOL_VERSION } from '@web-source-inspector/protocol';
export type {
  BridgeMessage,
  BridgeMessageType,
  BridgePayloadMap,
  IdeHelloPayload,
  IdeOpenResultPayload,
  IdeWorkspaceRoot,
  OpenSourcePageContext as PageDescriptor,
  ProtocolEnvelope,
  ProtocolVersion,
  ServerClaimResultPayload,
  ServerHelloAckPayload,
  ServerToIdeMessage,
  SessionDescriptor,
  SessionRootDescriptor,
  SourceAccuracy,
  SourceRange,
} from '@web-source-inspector/protocol';

export type BrowserTab = import('@web-source-inspector/protocol').BrowserTabDescriptor;

/** 扩展内部统一补齐可选 context，避免控制器重复处理 undefined。 */
export interface SourceCandidate
  extends Omit<OpenSourceCandidate, 'candidateKind' | 'contextBefore' | 'contextAfter'> {
  candidateKind: string;
  contextBefore: string | null;
  contextAfter: string | null;
}

export interface ServerOpenSourcePayload extends Omit<ProtocolServerOpenSourcePayload, 'candidates'> {
  candidates: SourceCandidate[];
}

export type OpenResultCode =
  | 'OK'
  | 'RANGE_ADJUSTED'
  | 'RANGE_STALE'
  | 'WORKSPACE_NOT_MATCHED'
  | 'PATH_REJECTED'
  | 'FILE_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'PROTOCOL_MISMATCH'
  | 'INTERNAL_ERROR';

export interface OpenSourceResult {
  openRequestId: string;
  success: boolean;
  code: OpenResultCode;
  adjusted?: boolean;
  message?: string;
  range?: SourceRange;
  accuracy?: SourceAccuracy;
}

export interface RootMapping {
  rootKey: string;
  sessionRoot: string;
  workspaceRoots: string[];
}
