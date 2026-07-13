import { createHash } from 'node:crypto';

import type { SourceRange } from './types';

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_ANCHOR_LENGTH = 512;
const MAX_ANCHOR_MATCHES = 64;
const MAX_RANGE_LENGTH_DRIFT = 4_096;

export interface TextPosition {
  line: number;
  character: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
  startOffset: number;
  endOffset: number;
}

export interface RelocationResult {
  status: 'exact' | 'adjusted' | 'stale';
  range: TextRange;
  matchCount: number;
}

export function createSourceDigest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function isValidSourceDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function offsetAt(text: string, lineStarts: readonly number[], line: number, column: number): number {
  const lineIndex = clampInteger(line - 1, 0, lineStarts.length - 1);
  const lineStart = lineStarts[lineIndex] ?? 0;
  const nextLineStart = lineStarts[lineIndex + 1] ?? text.length;
  const rawLineEnd = nextLineStart > lineStart && text.charCodeAt(nextLineStart - 1) === 10 ? nextLineStart - 1 : nextLineStart;
  const lineEnd = rawLineEnd > lineStart && text.charCodeAt(rawLineEnd - 1) === 13 ? rawLineEnd - 1 : rawLineEnd;
  return lineStart + clampInteger(column - 1, 0, lineEnd - lineStart);
}

function positionAt(text: string, lineStarts: readonly number[], offset: number): TextPosition {
  const safeOffset = clampInteger(offset, 0, text.length);
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((lineStarts[middle] ?? 0) > safeOffset) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const lineIndex = Math.max(0, low - 1);
  return {
    line: lineIndex,
    character: safeOffset - (lineStarts[lineIndex] ?? 0),
  };
}
function rangeFromOffsets(text: string, lineStarts: readonly number[], startOffset: number, endOffset: number): TextRange {
  const safeStart = clampInteger(startOffset, 0, text.length);
  const safeEnd = clampInteger(endOffset, safeStart, text.length);
  return {
    start: positionAt(text, lineStarts, safeStart),
    end: positionAt(text, lineStarts, safeEnd),
    startOffset: safeStart,
    endOffset: safeEnd,
  };
}

export function clampSourceRange(text: string, sourceRange: SourceRange): TextRange {
  const lineStarts = buildLineStarts(text);
  const startOffset = offsetAt(text, lineStarts, sourceRange.startLine, sourceRange.startColumn);
  const endOffset = offsetAt(text, lineStarts, sourceRange.endLine, sourceRange.endColumn);
  return rangeFromOffsets(text, lineStarts, startOffset, Math.max(startOffset, endOffset));
}

function collectOccurrences(text: string, needle: string, start: number, end: number): number[] {
  const occurrences: number[] = [];
  let offset = start;
  while (offset <= end && occurrences.length < MAX_ANCHOR_MATCHES) {
    const match = text.indexOf(needle, offset);
    if (match < 0 || match + needle.length > end) {
      break;
    }
    occurrences.push(match);
    offset = match + Math.max(needle.length, 1);
  }
  return occurrences;
}

function findAnchorCandidates(
  text: string,
  original: TextRange,
  contextBefore: string | undefined,
  contextAfter: string | undefined,
  windowCharacters: number,
): Array<{ startOffset: number; endOffset: number }> {
  const before = contextBefore && contextBefore.length <= MAX_ANCHOR_LENGTH ? contextBefore : undefined;
  const after = contextAfter && contextAfter.length <= MAX_ANCHOR_LENGTH ? contextAfter : undefined;
  if (!before && !after) {
    return [];
  }

  const searchStart = Math.max(0, original.startOffset - windowCharacters);
  const searchEnd = Math.min(text.length, original.endOffset + windowCharacters);
  const originalLength = original.endOffset - original.startOffset;
  const candidates: Array<{ startOffset: number; endOffset: number }> = [];

  if (before && after) {
    for (const beforeOffset of collectOccurrences(text, before, searchStart, searchEnd)) {
      const candidateStart = beforeOffset + before.length;
      const minimumEnd = Math.max(candidateStart, candidateStart + originalLength - MAX_RANGE_LENGTH_DRIFT);
      const maximumEnd = Math.min(searchEnd, candidateStart + originalLength + MAX_RANGE_LENGTH_DRIFT);
      for (const afterOffset of collectOccurrences(text, after, minimumEnd, maximumEnd + after.length)) {
        candidates.push({ startOffset: candidateStart, endOffset: afterOffset });
        if (candidates.length >= MAX_ANCHOR_MATCHES) {
          return candidates;
        }
      }
    }
  } else if (before) {
    for (const beforeOffset of collectOccurrences(text, before, searchStart, searchEnd)) {
      const startOffset = beforeOffset + before.length;
      candidates.push({ startOffset, endOffset: Math.min(text.length, startOffset + originalLength) });
    }
  } else if (after) {
    for (const afterOffset of collectOccurrences(text, after, searchStart, searchEnd)) {
      candidates.push({ startOffset: Math.max(0, afterOffset - originalLength), endOffset: afterOffset });
    }
  }

  const unique = new Map<string, { startOffset: number; endOffset: number }>();
  for (const candidate of candidates) {
    unique.set(`${candidate.startOffset}:${candidate.endOffset}`, candidate);
  }
  return [...unique.values()];
}

/** 摘要不一致时只接受窗口内唯一上下文匹配，禁止跨文件或多匹配猜测。 */
export function relocateSourceRange(
  text: string,
  sourceRange: SourceRange,
  sourceDigest: string,
  contextBefore?: string,
  contextAfter?: string,
  windowCharacters = 100_000,
): RelocationResult {
  const original = clampSourceRange(text, sourceRange);
  if (isValidSourceDigest(sourceDigest) && createSourceDigest(text) === sourceDigest) {
    return { status: 'exact', range: original, matchCount: 0 };
  }

  const candidates = findAnchorCandidates(text, original, contextBefore, contextAfter, windowCharacters);
  if (candidates.length !== 1) {
    return { status: 'stale', range: original, matchCount: candidates.length };
  }

  const lineStarts = buildLineStarts(text);
  const candidate = candidates[0];
  if (!candidate) {
    return { status: 'stale', range: original, matchCount: 0 };
  }
  return {
    status: 'adjusted',
    range: rangeFromOffsets(text, lineStarts, candidate.startOffset, candidate.endOffset),
    matchCount: 1,
  };
}
