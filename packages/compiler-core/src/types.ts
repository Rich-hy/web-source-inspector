import type {
  BrowserModifiers,
  CandidateKind,
  SourceAccuracy,
  SourceRange
} from '@web-source-inspector/protocol';

export type { SourceRange } from '@web-source-inspector/protocol';

export type SourceFramework = 'vue' | 'react' | 'html' | 'three';

export type SourceNodeKind =
  | 'element'
  | 'component'
  | 'fragment'
  | 'slot'
  | 'dynamic'
  | 'three-object';

export type ControlFlowKind = 'for' | 'if' | 'else-if' | 'else';

export interface ControlFlowSource {
  kind: ControlFlowKind;
  range: SourceRange;
}

export interface SourceRecord {
  sourceId: string;
  rootKey: string;
  relativePath: string;
  framework: SourceFramework;
  kind: SourceNodeKind;
  tagName: string;
  range: SourceRange;
  componentName: string | null;
  controlFlow: ControlFlowSource | null;
  parentSourceId: string | null;
  sourceDigest: string;
  contextBefore: string | null;
  contextAfter: string | null;
  moduleId: string;
  generation: number;
  accuracy: SourceAccuracy;
}

export interface SourceIdInput {
  normalizedRelativePath: string;
  moduleGeneration: number;
  nodeKind: SourceNodeKind;
  tagName: string;
  range: SourceRange;
  /** @deprecated 使用 range.startOffset。 */
  startOffset?: number;
  /** @deprecated 使用 range.endOffset。 */
  endOffset?: number;
  localSnippetDigest: string;
}

export interface SourceIdGeneratorOptions {
  protocolMajor?: number;
  /** @deprecated sourceId 固定为完整 256-bit Base64URL（43 字符）。 */
  length?: 43;
}

export type SourceIdGenerator = (input: SourceIdInput) => string;

export interface ResolvedSourceCandidate {
  candidateKind: CandidateKind;
  sourceId: string;
  rootKey: string;
  relativePath: string;
  range: SourceRange;
  sourceDigest: string;
  contextBefore: string | null;
  contextAfter: string | null;
  accuracy: SourceAccuracy;
  label: string;
  record: SourceRecord;
}

export type CandidatePreference = CandidateKind | 'default';

export interface CandidateSelectionInput {
  candidateKind?: CandidateKind;
  modifiers?: Partial<BrowserModifiers>;
}

export interface CandidateResolution {
  primary: ResolvedSourceCandidate;
  candidates: ResolvedSourceCandidate[];
  preference: CandidatePreference;
  preferenceMatched: boolean;
}

export interface ManifestTombstone {
  sourceId: string;
  moduleId: string;
  generation: number;
  staleAt: number;
  expiresAt: number;
}

export type ManifestResolveResult =
  | { status: 'found'; record: SourceRecord }
  | { status: 'stale'; tombstone: ManifestTombstone }
  | { status: 'not-found' };

export type ManifestCandidateResolveResult =
  | { status: 'found'; resolution: CandidateResolution }
  | { status: 'stale'; tombstone: ManifestTombstone }
  | { status: 'not-found' };

export interface ManifestDiagnostic {
  code: 'SOURCE_ID_COLLISION';
  message: string;
  moduleId: string;
  sourceId: string;
}

export interface SourceManifestOptions {
  tombstoneTtlMs?: number;
  tombstoneCapacity?: number;
  recordCapacity?: number;
  now?: () => number;
  onDiagnostic?: (diagnostic: ManifestDiagnostic) => void;
}

export interface ManifestReplaceResult {
  moduleId: string;
  generation: number;
  records: SourceRecord[];
  replacedCount: number;
  collisionCount: number;
}

export interface ManifestBuildIdentity {
  compilerId: string;
  compilationId: string;
  buildId: number;
}

export interface ManifestModuleStageInput {
  moduleId: string;
  generation: number;
  fullDigest: string;
  records: readonly SourceRecord[];
}

export interface ManifestCommitResult {
  identity: ManifestBuildIdentity;
  changedModules: string[];
  removedModules: string[];
  recordCount: number;
}

export interface SourceManifestStage {
  readonly identity: ManifestBuildIdentity;
  readonly state: 'active' | 'committed' | 'discarded' | 'superseded';
  stageModule(input: ManifestModuleStageInput): void;
  removeModule(moduleId: string): void;
  commit(): ManifestCommitResult;
  discard(): void;
}
