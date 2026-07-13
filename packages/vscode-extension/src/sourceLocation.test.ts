import { describe, expect, it } from 'vitest';

import { clampSourceRange, createSourceDigest, relocateSourceRange } from './sourceLocation';
import type { SourceRange } from './types';

function range(overrides: Partial<SourceRange> = {}): SourceRange {
  return {
    startLine: 2,
    startColumn: 1,
    endLine: 2,
    endColumn: 22,
    startOffset: 7,
    endOffset: 28,
    ...overrides,
  };
}

describe('source digest and range conversion', () => {
  it('uses the agreed full-file SHA-256 format', () => {
    expect(createSourceDigest('hello')).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('uses UTF-16 columns and excludes CRLF from line content', () => {
    expect(
      clampSourceRange('😀x\r\nabc', range({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 })),
    ).toMatchObject({ startOffset: 0, endOffset: 2 });
  });
});
describe('relocateSourceRange', () => {
  const diskText = 'before\n<button>Save</button>\nafter';
  const sourceRange = range();

  it('keeps the original range when the complete file digest matches', () => {
    const result = relocateSourceRange(diskText, sourceRange, createSourceDigest(diskText), 'before\n', '\nafter');
    expect(result.status).toBe('exact');
    expect(result.range.start).toEqual({ line: 1, character: 0 });
  });

  it('moves only when context anchors have one match in the local window', () => {
    const editedText = 'unsaved header\nbefore\n<button>Save</button>\nafter';
    const result = relocateSourceRange(
      editedText,
      sourceRange,
      createSourceDigest(diskText),
      'before\n',
      '\nafter',
    );
    expect(result.status).toBe('adjusted');
    expect(result.range.start).toEqual({ line: 2, character: 0 });
    expect(editedText.slice(result.range.startOffset, result.range.endOffset)).toBe('<button>Save</button>');
  });

  it('keeps the original position when context is ambiguous', () => {
    const editedText = 'A<target>Z\nA<target>Z';
    const result = relocateSourceRange(
      editedText,
      range({ startLine: 1, endLine: 1, endColumn: 9 }),
      createSourceDigest('old'),
      'A',
      'Z',
    );
    expect(result.status).toBe('stale');
    expect(result.matchCount).toBeGreaterThan(1);
  });

  it('does not guess when no anchors are supplied', () => {
    expect(relocateSourceRange(diskText, sourceRange, createSourceDigest('different')).status).toBe('stale');
  });
});
