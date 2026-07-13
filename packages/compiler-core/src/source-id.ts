import {
  createHmac,
  randomBytes,
  type BinaryLike,
  type KeyObject
} from 'node:crypto';
import {
  PROTOCOL_MAJOR,
  PROTOCOL_LIMITS,
  validateSourceRange
} from '@web-source-inspector/protocol';
import { isSourceDigest } from './digest';
import { normalizeRootIdentity, normalizeWireRelativePath } from './path';
import type {
  SourceIdGenerator,
  SourceIdGeneratorOptions,
  SourceIdInput,
  SourceNodeKind
} from './types';

export type SessionSourceKey = BinaryLike | KeyObject;

const SOURCE_NODE_KINDS = new Set<SourceNodeKind>([
  'element',
  'component',
  'fragment',
  'slot',
  'dynamic',
  'three-object'
]);
const FULL_SOURCE_ID_LENGTH = 43;

function assertSecretStrength(secret: SessionSourceKey): void {
  if (typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') < 32) {
    throw new RangeError('sessionSourceKey 至少需要 256 bit 有效输入');
  }
  if (ArrayBuffer.isView(secret) && secret.byteLength < 32) {
    throw new RangeError('sessionSourceKey 至少需要 256 bit 有效输入');
  }
  if (
    typeof secret === 'object' &&
    secret !== null &&
    'symmetricKeySize' in secret &&
    typeof secret.symmetricKeySize === 'number' &&
    secret.symmetricKeySize < 32
  ) {
    throw new RangeError('sessionSourceKey 至少需要 256 bit 有效输入');
  }
}

function assertSourceIdInput(input: SourceIdInput): void {
  normalizeWireRelativePath(input.normalizedRelativePath);
  if (!Number.isSafeInteger(input.moduleGeneration) || input.moduleGeneration < 0) {
    throw new RangeError('moduleGeneration 必须是非负安全整数');
  }
  if (!SOURCE_NODE_KINDS.has(input.nodeKind)) {
    throw new TypeError('nodeKind 不受支持');
  }
  if (
    typeof input.tagName !== 'string' ||
    input.tagName.length === 0 ||
    input.tagName.length > PROTOCOL_LIMITS.labelLength ||
    /[\u0000-\u001f\u007f]/.test(input.tagName)
  ) {
    throw new TypeError('tagName 格式无效');
  }
  if (!validateSourceRange(input.range).ok) {
    throw new RangeError('sourceId range 必须是有效的 1-based UTF-16 [start, end) 范围');
  }
  if (
    (input.startOffset !== undefined &&
      input.startOffset !== input.range.startOffset) ||
    (input.endOffset !== undefined && input.endOffset !== input.range.endOffset)
  ) {
    throw new RangeError('deprecated sourceId offset 必须与 range 一致');
  }
  if (!isSourceDigest(input.localSnippetDigest)) {
    throw new TypeError('localSnippetDigest 必须是 sha256 摘要');
  }
}

export function createSessionSourceKey(byteLength = 32): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 32 || byteLength > 128) {
    throw new RangeError('sessionSourceKey 长度必须在 32 到 128 bytes 之间');
  }
  return randomBytes(byteLength).toString('base64url');
}

export function createSourceIdGenerator(
  sessionSourceKey: SessionSourceKey,
  options: SourceIdGeneratorOptions = {}
): SourceIdGenerator {
  assertSecretStrength(sessionSourceKey);
  const protocolMajor = options.protocolMajor ?? PROTOCOL_MAJOR;
  const length = options.length ?? FULL_SOURCE_ID_LENGTH;
  if (!Number.isSafeInteger(protocolMajor) || protocolMajor < 1) {
    throw new RangeError('protocolMajor 必须是正安全整数');
  }
  if (length !== FULL_SOURCE_ID_LENGTH) {
    throw new RangeError(`sourceId 必须保留完整 ${FULL_SOURCE_ID_LENGTH} 个 Base64URL 字符`);
  }

  return (input: SourceIdInput): string => {
    assertSourceIdInput(input);
    // JSON 数组保留字段边界，避免简单拼接产生等价输入。
    const identity = JSON.stringify([
      'wsi-source-id',
      protocolMajor,
      input.normalizedRelativePath,
      input.moduleGeneration,
      input.nodeKind,
      input.tagName,
      input.range.startLine,
      input.range.startColumn,
      input.range.endLine,
      input.range.endColumn,
      input.range.startOffset,
      input.range.endOffset,
      input.localSnippetDigest
    ]);
    const sourceId = createHmac('sha256', sessionSourceKey)
      .update(identity)
      .digest('base64url');
    if (sourceId.length !== length) {
      throw new Error('运行环境未生成完整的 SHA-256 Base64URL sourceId');
    }
    return sourceId;
  };
}

export function createRootKey(
  canonicalRoot: string,
  sessionSourceKey: SessionSourceKey
): string {
  assertSecretStrength(sessionSourceKey);
  const rootIdentity = normalizeRootIdentity(canonicalRoot);
  const digest = createHmac('sha256', sessionSourceKey)
    .update(JSON.stringify(['root', rootIdentity]))
    .digest('base64url')
    .slice(0, 22);
  return `root_${digest}`;
}
