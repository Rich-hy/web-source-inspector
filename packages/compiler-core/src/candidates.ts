import type { CandidateKind } from '@web-source-inspector/protocol';
import type {
  CandidatePreference,
  CandidateResolution,
  CandidateSelectionInput,
  ResolvedSourceCandidate,
  SourceRecord
} from './types';

const MAX_PARENT_DEPTH = 16;

export function getCandidatePreference(
  input: CandidateSelectionInput = {}
): CandidatePreference {
  if (input.modifiers?.alt) {
    return 'control-flow';
  }
  if (input.modifiers?.shift) {
    return 'component';
  }
  return input.candidateKind ?? 'default';
}

export function candidateKindForRecord(record: SourceRecord): CandidateKind {
  switch (record.kind) {
    case 'element':
      return 'element';
    case 'component':
      return 'component';
    case 'dynamic':
      return 'dynamic';
    case 'three-object':
      return 'three';
    case 'fragment':
    case 'slot':
      return 'call-site';
  }
}

function labelForRecord(record: SourceRecord): string {
  if (record.componentName) {
    return record.componentName;
  }
  return record.tagName ? `<${record.tagName}>` : record.relativePath;
}

function createRecordCandidate(record: SourceRecord): ResolvedSourceCandidate {
  return {
    candidateKind: candidateKindForRecord(record),
    sourceId: record.sourceId,
    rootKey: record.rootKey,
    relativePath: record.relativePath,
    range: record.range,
    sourceDigest: record.sourceDigest,
    contextBefore: record.contextBefore,
    contextAfter: record.contextAfter,
    accuracy: record.accuracy,
    label: labelForRecord(record),
    record
  };
}

function createControlFlowCandidate(
  record: SourceRecord
): ResolvedSourceCandidate | undefined {
  if (!record.controlFlow) {
    return undefined;
  }
  return {
    ...createRecordCandidate(record),
    candidateKind: 'control-flow',
    range: record.controlFlow.range,
    label: `${record.controlFlow.kind}: ${labelForRecord(record)}`
  };
}

function candidateIdentity(candidate: ResolvedSourceCandidate): string {
  return [
    candidate.candidateKind,
    candidate.sourceId,
    candidate.range.startOffset,
    candidate.range.endOffset
  ].join(':');
}

export function resolveSourceCandidates(
  selectedRecord: SourceRecord,
  lookup: (sourceId: string) => SourceRecord | undefined,
  preference: CandidatePreference = 'default'
): CandidateResolution {
  const candidates: ResolvedSourceCandidate[] = [];
  const identities = new Set<string>();
  const visitedSourceIds = new Set<string>();

  const addCandidate = (candidate: ResolvedSourceCandidate | undefined): void => {
    if (!candidate) {
      return;
    }
    const identity = candidateIdentity(candidate);
    if (!identities.has(identity)) {
      identities.add(identity);
      candidates.push(candidate);
    }
  };

  let currentRecord: SourceRecord | undefined = selectedRecord;
  for (
    let depth = 0;
    currentRecord && depth < MAX_PARENT_DEPTH;
    depth += 1
  ) {
    if (visitedSourceIds.has(currentRecord.sourceId)) {
      break;
    }
    visitedSourceIds.add(currentRecord.sourceId);
    addCandidate(createRecordCandidate(currentRecord));
    addCandidate(createControlFlowCandidate(currentRecord));
    currentRecord = currentRecord.parentSourceId
      ? lookup(currentRecord.parentSourceId)
      : undefined;
  }

  const preferred =
    preference === 'default'
      ? candidates[0]
      : candidates.find((candidate) => candidate.candidateKind === preference);
  const fallback = candidates[0];
  if (!fallback) {
    throw new Error('候选解析至少需要一条已验证 SourceRecord');
  }
  return {
    primary: preferred ?? fallback,
    candidates,
    preference,
    preferenceMatched: preference === 'default' || preferred !== undefined
  };
}
