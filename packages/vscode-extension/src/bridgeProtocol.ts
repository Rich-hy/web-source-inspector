import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  createProtocolEnvelope,
  isProtocolVersionCompatible,
  utf8ByteLength,
  validateBridgeMessage,
  validateSourceRange,
  type BridgeMessageType,
  type BridgePayloadMap,
  type OpenSourceCandidate,
  type ProtocolEnvelope,
  type ServerToIdeMessage,
} from '@web-source-inspector/protocol';

import {
  type ServerOpenSourcePayload,
  type SourceCandidate,
  type SourceRange,
} from './types';

const MAX_TIMESTAMP_DRIFT_MS = 10 * 60_000;
const UNSAFE_CONTEXT_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const SERVER_TO_IDE_MESSAGE_TYPES = new Set<BridgeMessageType>([
  'server:hello-ack',
  'server:claim-result',
  'heartbeat',
  'server:open-source',
  'server:tabs-changed',
  'server:session-dispose',
  'error',
]);

export type IncomingBridgeMessage = ServerToIdeMessage;

export type IncomingParseResult =
  | { ok: true; message: IncomingBridgeMessage }
  | { ok: false; code: 'MESSAGE_TOO_LARGE' | 'MALFORMED_JSON' | 'INVALID_MESSAGE' | 'PROTOCOL_MISMATCH' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 源码上下文需要保留换行和缩进，但仍拒绝不可安全展示的控制字符。 */
function isSourceContext(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= PROTOCOL_LIMITS.contextLength &&
    !UNSAFE_CONTEXT_CONTROL_CHARACTER.test(value)
  );
}

export function parseIncomingBridgeMessage(rawMessage: string, expectedSessionId: string): IncomingParseResult {
  if (utf8ByteLength(rawMessage) > PROTOCOL_LIMITS.bridgeMessageBytes) {
    return { ok: false, code: 'MESSAGE_TOO_LARGE' };
  }
  let value: unknown;
  try {
    value = JSON.parse(rawMessage);
  } catch {
    return { ok: false, code: 'MALFORMED_JSON' };
  }
  if (
    isPlainObject(value) &&
    typeof value.protocolVersion === 'string' &&
    !isProtocolVersionCompatible(value.protocolVersion)
  ) {
    return { ok: false, code: 'PROTOCOL_MISMATCH' };
  }
  const validated = validateBridgeMessage(value);
  if (!validated.ok) {
    return {
      ok: false,
      code: validated.error.code === 'PROTOCOL_MISMATCH' ? 'PROTOCOL_MISMATCH' : 'INVALID_MESSAGE',
    };
  }
  const message = validated.value;
  if (
    !SERVER_TO_IDE_MESSAGE_TYPES.has(message.type) ||
    message.sessionId !== expectedSessionId ||
    message.senderId !== expectedSessionId ||
    Math.abs(Date.now() - message.timestamp) > MAX_TIMESTAMP_DRIFT_MS
  ) {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
  return { ok: true, message: message as IncomingBridgeMessage };
}

export function parseSourceRange(value: unknown): SourceRange | undefined {
  const validated = validateSourceRange(value);
  if (!validated.ok) {
    return undefined;
  }
  const range = validated.value;
  if (
    range.startLine > 10_000_000 ||
    range.endLine > 10_000_000 ||
    range.startColumn > 10_000_000 ||
    range.endColumn > 10_000_000
  ) {
    return undefined;
  }
  return range;
}

function normalizeSourceCandidate(value: OpenSourceCandidate): SourceCandidate | undefined {
  const range = parseSourceRange(value.range);
  const contextBefore = value.contextBefore ?? null;
  const contextAfter = value.contextAfter ?? null;
  if (!range || (contextBefore !== null && !isSourceContext(contextBefore)) || (contextAfter !== null && !isSourceContext(contextAfter))) {
    return undefined;
  }
  return {
    ...value,
    range,
    contextBefore,
    contextAfter,
  };
}

export function parseOpenSourcePayload(value: unknown): ServerOpenSourcePayload | undefined {
  const validated = validateBridgeMessage({
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'payload-validation',
    type: 'server:open-source',
    sessionId: 'payload-session',
    senderId: 'payload-session',
    timestamp: Date.now(),
    payload: value,
  });
  if (!validated.ok || validated.value.type !== 'server:open-source') {
    return undefined;
  }
  const payload = validated.value.payload;
  const range = parseSourceRange(payload.range);
  if (
    !range ||
    (payload.contextBefore !== null && !isSourceContext(payload.contextBefore)) ||
    (payload.contextAfter !== null && !isSourceContext(payload.contextAfter))
  ) {
    return undefined;
  }
  const candidates = (payload.candidates ?? []).map(normalizeSourceCandidate);
  if (candidates.some((candidate) => candidate === undefined)) {
    return undefined;
  }
  return {
    ...payload,
    range,
    candidates: candidates as SourceCandidate[],
  };
}

export function createEnvelope<TType extends BridgeMessageType>(
  type: TType,
  payload: BridgePayloadMap[TType],
  sessionId: string,
  senderId: string,
  messageId: string,
): ProtocolEnvelope<TType> {
  return createProtocolEnvelope(type, payload, {
    messageId,
    sessionId,
    senderId,
  });
}
