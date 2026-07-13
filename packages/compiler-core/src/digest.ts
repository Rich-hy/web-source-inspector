import { createHash } from 'node:crypto';

const SOURCE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function createSourceDigest(source: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

export function createLocalSnippetDigest(
  source: string,
  startOffset: number,
  endOffset: number
): string {
  if (
    !Number.isSafeInteger(startOffset) ||
    !Number.isSafeInteger(endOffset) ||
    startOffset < 0 ||
    endOffset < startOffset ||
    endOffset > source.length
  ) {
    throw new RangeError('源码片段 offset 必须是有效的 UTF-16 [start, end) 范围');
  }
  return createSourceDigest(source.slice(startOffset, endOffset));
}

export function isSourceDigest(value: string): boolean {
  return SOURCE_DIGEST_PATTERN.test(value);
}
