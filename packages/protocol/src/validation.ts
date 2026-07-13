import {
  BROWSER_TOKEN_AUDIENCE,
  CLI_JSON_SCHEMA_VERSION,
  PROTOCOL_LIMITS,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  SESSION_SCHEMA_VERSION
} from './constants';
import type {
  BridgeMessage,
  BridgeMessageType,
  BridgePayloadMap,
  BrowserDisposePayload,
  BrowserHeartbeatPayload,
  BrowserHelloPayload,
  BrowserMetadataRequestPayload,
  BrowserSelectPayload,
  BrowserToServerEvent,
  BrowserToServerPayloadMap,
  BrowserToViteEvent,
  BrowserToVitePayloadMap,
  CandidateKind,
  CliJsonDiagnostic,
  CliJsonEnvelope,
  CliJsonOperation,
  ErrorPayload,
  HeartbeatPayload,
  IdeClaimPayload,
  IdeFocusPayload,
  IdeHelloPayload,
  IdeOpenResultPayload,
  IdeSetBrowserModePayload,
  OpenSourceCandidate,
  ProtocolErrorCode,
  ProtocolValidationIssue,
  ProtocolValidationResult,
  ProtocolVersion,
  ServerHelloAckPayload,
  ServerHeartbeatPayload,
  ServerConnectionPayload,
  ServerClaimResultPayload,
  ServerMetadataPayload,
  ServerOpenSourcePayload,
  ServerResultPayload,
  ServerSessionDisposePayload,
  ServerSetModePayload,
  ServerToBrowserEvent,
  ServerToBrowserPayloadMap,
  ServerTabsChangedPayload,
  SessionDescriptor,
  SessionRootDescriptor,
  SourceRange,
  ViteToBrowserEvent,
  ViteToBrowserPayloadMap
} from './types';

type UnknownRecord = Record<string, unknown>;

const BRIDGE_MESSAGE_TYPES = [
  'ide:hello',
  'server:hello-ack',
  'ide:claim',
  'server:claim-result',
  'ide:focus',
  'heartbeat',
  'server:open-source',
  'ide:open-result',
  'ide:set-browser-mode',
  'server:tabs-changed',
  'server:session-dispose',
  'error'
] as const satisfies readonly BridgeMessageType[];

const PROTOCOL_ERROR_CODES = [
  'PROTOCOL_MISMATCH',
  'AUTH_FAILED',
  'IDE_NOT_CONNECTED',
  'IDE_NOT_CLAIMED',
  'IDE_SELECTION_REQUIRED',
  'IDE_REQUEST_TIMEOUT',
  'SOURCE_NOT_FOUND',
  'SOURCE_STALE',
  'WORKSPACE_NOT_MATCHED',
  'PATH_REJECTED',
  'FILE_NOT_FOUND',
  'RANGE_ADJUSTED',
  'RANGE_STALE',
  'TARGET_UNSUPPORTED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'INVALID_MESSAGE',
  'MESSAGE_TOO_LARGE',
  'UNKNOWN_MESSAGE_TYPE',
  'SESSION_NOT_FOUND',
  'CLIENT_NOT_REGISTERED',
  'UNKNOWN_REQUEST',
  'INVALID_IDE_HELLO',
  'REPLAY_CONFLICT',
  'REQUEST_TIMEOUT',
  'PLAN_CONTEXT_REQUIRED',
  'PLAN_STALE',
  'RECOVERY_REQUIRED',
  'TRANSACTION_CONFLICT',
  'TEMPLATE_PIPELINE_MISMATCH',
  'MULTI_COMPILER_UNSUPPORTED',
  'WDS_TRANSPORT_UNSUPPORTED',
  'SOURCE_ID_COLLISION',
  'BUILD_SUPERSEDED'
] as const satisfies readonly ProtocolErrorCode[];

const CLI_JSON_OPERATIONS = [
  'init:plan',
  'init:apply',
  'doctor',
  'remove:plan',
  'remove:apply'
] as const satisfies readonly CliJsonOperation[];

const CANDIDATE_KINDS = [
  'element',
  'component',
  'call-site',
  'control-flow',
  'dynamic',
  'three'
] as const satisfies readonly CandidateKind[];

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_SEGMENT_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

class ValidationContext {
  error: ProtocolValidationIssue | undefined;

  fail(
    path: string,
    message: string,
    code: ProtocolValidationIssue['code'] = 'INVALID_MESSAGE'
  ): false {
    this.error ??= { code, path, message };
    return false;
  }

  record(
    value: unknown,
    path: string,
    required: readonly string[],
    optional: readonly string[] = []
  ): UnknownRecord | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, '必须是对象');
      return undefined;
    }

    const record = value as UnknownRecord;
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        this.fail(`${path}.${key}`, '包含未知字段');
        return undefined;
      }
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        this.fail(`${path}.${key}`, '缺少必填字段');
        return undefined;
      }
    }
    return record;
  }

  string(
    value: unknown,
    path: string,
    minimumLength: number,
    maximumLength: number,
    pattern?: RegExp
  ): value is string {
    if (typeof value !== 'string') {
      return this.fail(path, '必须是字符串');
    }
    if (value.length < minimumLength || value.length > maximumLength) {
      return this.fail(
        path,
        `长度必须在 ${minimumLength} 到 ${maximumLength} 之间`
      );
    }
    if (pattern && !pattern.test(value)) {
      return this.fail(path, '字符串格式无效');
    }
    return true;
  }

  boolean(value: unknown, path: string): value is boolean {
    return typeof value === 'boolean' || this.fail(path, '必须是布尔值');
  }

  integer(
    value: unknown,
    path: string,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER
  ): value is number {
    if (!Number.isSafeInteger(value)) {
      return this.fail(path, '必须是安全整数');
    }
    const integer = value as number;
    if (integer < minimum || integer > maximum) {
      return this.fail(path, `必须在 ${minimum} 到 ${maximum} 之间`);
    }
    return true;
  }

  enum<T extends string>(
    value: unknown,
    path: string,
    allowed: readonly T[]
  ): value is T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      return this.fail(path, `必须是以下值之一：${allowed.join(', ')}`);
    }
    return true;
  }

  array(
    value: unknown,
    path: string,
    maximumLength: number
  ): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.fail(path, '必须是数组');
      return undefined;
    }
    if (value.length > maximumLength) {
      this.fail(path, `数组长度不能超过 ${maximumLength}`);
      return undefined;
    }
    return value;
  }
}

function success<T>(value: T): ProtocolValidationResult<T> {
  return { ok: true, value };
}

function failure<T>(error: ProtocolValidationIssue): ProtocolValidationResult<T> {
  return { ok: false, error };
}

function resultFromContext<T>(
  context: ValidationContext,
  value: unknown
): ProtocolValidationResult<T> {
  if (context.error) {
    return failure(context.error);
  }
  return success(value as T);
}

function validateProtocolVersionValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ProtocolVersion {
  if (!context.string(value, path, 3, 16, /^\d+\.\d+$/)) {
    return false;
  }
  const majorText = value.split('.', 1)[0];
  if (Number(majorText) !== PROTOCOL_MAJOR) {
    return context.fail(path, '协议 major 版本不兼容', 'PROTOCOL_MISMATCH');
  }
  return true;
}

function validateSafeId(
  context: ValidationContext,
  value: unknown,
  path: string,
  maximumLength: number
): value is string {
  return context.string(value, path, 1, maximumLength, SAFE_ID_PATTERN);
}

function validateTimestamp(
  context: ValidationContext,
  value: unknown,
  path: string
): value is number {
  return context.integer(value, path, 0);
}

function validateSourceRangeValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is SourceRange {
  const record = context.record(value, path, [
    'startLine',
    'startColumn',
    'endLine',
    'endColumn',
    'startOffset',
    'endOffset'
  ]);
  if (!record) {
    return false;
  }

  const valid =
    context.integer(record.startLine, `${path}.startLine`, 1) &&
    context.integer(record.startColumn, `${path}.startColumn`, 1) &&
    context.integer(record.endLine, `${path}.endLine`, 1) &&
    context.integer(record.endColumn, `${path}.endColumn`, 1) &&
    context.integer(record.startOffset, `${path}.startOffset`, 0) &&
    context.integer(record.endOffset, `${path}.endOffset`, 0);
  if (!valid) {
    return false;
  }

  const range = record as unknown as SourceRange;
  if (range.endOffset < range.startOffset) {
    return context.fail(`${path}.endOffset`, '结束 offset 不能早于起始 offset');
  }
  if (
    range.endLine < range.startLine ||
    (range.endLine === range.startLine &&
      range.endColumn < range.startColumn)
  ) {
    return context.fail(path, '结束行列不能早于起始行列');
  }
  const offsetsAreEqual = range.endOffset === range.startOffset;
  const positionsAreEqual =
    range.endLine === range.startLine &&
    range.endColumn === range.startColumn;
  if (offsetsAreEqual !== positionsAreEqual) {
    return context.fail(path, '空范围的 offset 与行列必须同时相等');
  }
  return true;
}

function validateStringArray(
  context: ValidationContext,
  value: unknown,
  path: string,
  maximumCount: number,
  maximumItemLength: number
): value is string[] {
  const values = context.array(value, path, maximumCount);
  if (!values) {
    return false;
  }
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (
      !context.string(
        item,
        `${path}[${index}]`,
        1,
        maximumItemLength,
        SAFE_ID_PATTERN
      )
    ) {
      return false;
    }
    if (seen.has(item)) {
      return context.fail(`${path}[${index}]`, '数组项不能重复');
    }
    seen.add(item);
  }
  return true;
}

function validateUrl(
  context: ValidationContext,
  value: unknown,
  path: string
): value is string {
  if (!context.string(value, path, 1, PROTOCOL_LIMITS.urlLength)) {
    return false;
  }
  return (
    !CONTROL_CHARACTER_PATTERN.test(value) ||
    context.fail(path, 'URL 不能包含控制字符')
  );
}

function validateOrigin(
  context: ValidationContext,
  value: unknown,
  path: string
): value is string {
  if (!validateUrl(context, value, path)) {
    return false;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.origin !== value
    ) {
      return context.fail(path, '必须是无凭据、无路径的 HTTP(S) origin');
    }
  } catch {
    return context.fail(path, 'origin 格式无效');
  }
  return true;
}

function validateBrowserPage(
  context: ValidationContext,
  value: unknown,
  path: string
): boolean {
  const record = context.record(value, path, ['origin', 'pathname', 'title']);
  if (
    !record ||
    !validateOrigin(context, record.origin, `${path}.origin`) ||
    !validatePathname(context, record.pathname, `${path}.pathname`)
  ) {
    return false;
  }
  if (
    !context.string(record.title, `${path}.title`, 0, PROTOCOL_LIMITS.labelLength)
  ) {
    return false;
  }
  return true;
}

function validatePathname(
  context: ValidationContext,
  value: unknown,
  path: string
): value is string {
  if (!context.string(value, path, 1, PROTOCOL_LIMITS.urlLength)) {
    return false;
  }
  if (!value.startsWith('/')) {
    return context.fail(path, 'pathname 必须以 / 开头');
  }
  if (CONTROL_CHARACTER_PATTERN.test(value) || /[?#]/.test(value)) {
    return context.fail(path, 'pathname 不能包含控制字符、query 或 fragment');
  }
  return true;
}

function validateServerContext(
  context: ValidationContext,
  record: UnknownRecord,
  path: string
): boolean {
  return (
    validateProtocolVersionValue(
      context,
      record.protocolVersion,
      `${path}.protocolVersion`
    ) &&
    validateSafeId(
      context,
      record.sessionId,
      `${path}.sessionId`,
      PROTOCOL_LIMITS.sessionIdLength
    ) &&
    validateSafeId(
      context,
      record.pageClientId,
      `${path}.pageClientId`,
      PROTOCOL_LIMITS.clientIdLength
    ) &&
    validateTimestamp(context, record.timestamp, `${path}.timestamp`)
  );
}

function validateBrowserContext(
  context: ValidationContext,
  record: UnknownRecord,
  path: string
): boolean {
  if (
    !validateServerContext(context, record, path) ||
    !context.string(
      record.browserToken,
      `${path}.browserToken`,
      PROTOCOL_LIMITS.sourceIdLength,
      PROTOCOL_LIMITS.tokenLength,
      /^[A-Za-z0-9_-]+$/
    )
  ) {
    return false;
  }
  return record.tokenAudience === BROWSER_TOKEN_AUDIENCE ||
    context.fail(`${path}.tokenAudience`, 'browser token audience 无效');
}

function validateBrowserModifiers(
  context: ValidationContext,
  value: unknown,
  path: string
): boolean {
  const record = context.record(value, path, ['shift', 'alt']);
  return Boolean(
    record &&
      context.boolean(record.shift, `${path}.shift`) &&
      context.boolean(record.alt, `${path}.alt`)
  );
}

function validateBrowserHelloValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is BrowserHelloPayload {
  const record = context.record(value, path, [
    'protocolVersion',
    'sessionId',
    'pageClientId',
    'timestamp',
    'browserToken',
    'tokenAudience',
    'runtimeVersion',
    'capabilities',
    'page'
  ]);
  return Boolean(
    record &&
      validateBrowserContext(context, record, path) &&
      context.string(
        record.runtimeVersion,
        `${path}.runtimeVersion`,
        1,
        PROTOCOL_LIMITS.versionLength
      ) &&
      validateStringArray(
        context,
        record.capabilities,
        `${path}.capabilities`,
        PROTOCOL_LIMITS.capabilityCount,
        PROTOCOL_LIMITS.capabilityLength
      ) &&
      validateBrowserPage(context, record.page, `${path}.page`)
  );
}

function validateBrowserHeartbeatValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is BrowserHeartbeatPayload {
  const record = context.record(value, path, [
    'protocolVersion',
    'sessionId',
    'pageClientId',
    'timestamp',
    'browserToken',
    'tokenAudience',
    'sequence'
  ]);
  return Boolean(
    record &&
      validateBrowserContext(context, record, path) &&
      context.integer(record.sequence, `${path}.sequence`, 0)
  );
}

function validateBrowserSelectValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is BrowserSelectPayload {
  const record = context.record(
    value,
    path,
    [
      'protocolVersion',
      'sessionId',
      'pageClientId',
      'timestamp',
      'browserToken',
      'tokenAudience',
      'sourceId',
      'candidateKind',
      'modifiers',
      'page'
    ],
    ['requestId']
  );
  if (
    !record ||
    !validateBrowserContext(context, record, path) ||
    !validateSourceIdValue(context, record.sourceId, `${path}.sourceId`) ||
    !context.enum(
      record.candidateKind,
      `${path}.candidateKind`,
      CANDIDATE_KINDS
    ) ||
    !validateBrowserModifiers(context, record.modifiers, `${path}.modifiers`) ||
    !validateBrowserPage(context, record.page, `${path}.page`)
  ) {
    return false;
  }
  return (
    record.requestId === undefined ||
    validateSafeId(
      context,
      record.requestId,
      `${path}.requestId`,
      PROTOCOL_LIMITS.messageIdLength
    )
  );
}

function validateBrowserMetadataRequestValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is BrowserMetadataRequestPayload {
  const record = context.record(
    value,
    path,
    [
      'protocolVersion',
      'sessionId',
      'pageClientId',
      'timestamp',
      'browserToken',
      'tokenAudience',
      'sourceId'
    ],
    ['requestId']
  );
  if (
    !record ||
    !validateBrowserContext(context, record, path) ||
    !validateSourceIdValue(context, record.sourceId, `${path}.sourceId`)
  ) {
    return false;
  }
  return (
    record.requestId === undefined ||
    validateSafeId(
      context,
      record.requestId,
      `${path}.requestId`,
      PROTOCOL_LIMITS.messageIdLength
    )
  );
}

function validateBrowserDisposeValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is BrowserDisposePayload {
  const record = context.record(value, path, [
    'protocolVersion',
    'sessionId',
    'pageClientId',
    'timestamp',
    'browserToken',
    'tokenAudience',
    'reason'
  ]);
  return Boolean(
    record &&
      validateBrowserContext(context, record, path) &&
      context.enum(record.reason, `${path}.reason`, ['unload', 'hmr', 'manual'])
  );
}

function validateViteContext(
  context: ValidationContext,
  record: UnknownRecord,
  path: string
): boolean {
  return validateServerContext(context, record, path);
}

function validateServerSetModeValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ServerSetModePayload {
  const record = context.record(
    value,
    path,
    ['protocolVersion', 'sessionId', 'pageClientId', 'timestamp', 'enabled'],
    ['mode']
  );
  if (
    !record ||
    !validateViteContext(context, record, path) ||
    !context.boolean(record.enabled, `${path}.enabled`)
  ) {
    return false;
  }
  return (
    record.mode === undefined ||
    context.enum(record.mode, `${path}.mode`, ['once', 'continuous'])
  );
}

function validateServerConnectionValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ServerConnectionPayload {
  const record = context.record(
    value,
    path,
    ['protocolVersion', 'sessionId', 'pageClientId', 'timestamp', 'connected'],
    ['ideName', 'message']
  );
  if (
    !record ||
    !validateViteContext(context, record, path) ||
    !context.boolean(record.connected, `${path}.connected`)
  ) {
    return false;
  }
  if (
    record.ideName !== undefined &&
    !context.string(
      record.ideName,
      `${path}.ideName`,
      1,
      PROTOCOL_LIMITS.labelLength
    )
  ) {
    return false;
  }
  return record.message === undefined ||
    context.string(
      record.message,
      `${path}.message`,
      1,
      PROTOCOL_LIMITS.errorMessageLength
    );
}

function validateServerHeartbeatValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ServerHeartbeatPayload {
  const record = context.record(value, path, [
    'protocolVersion',
    'sessionId',
    'pageClientId',
    'timestamp',
    'sequence',
    'acknowledged',
    'serverTime'
  ]);
  return Boolean(
    record &&
      validateServerContext(context, record, path) &&
      context.integer(record.sequence, `${path}.sequence`, 0) &&
      context.boolean(record.acknowledged, `${path}.acknowledged`) &&
      (record.acknowledged === true ||
        context.fail(`${path}.acknowledged`, '必须为 true')) &&
      validateTimestamp(context, record.serverTime, `${path}.serverTime`)
  );
}

function validateServerMetadataValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ServerMetadataPayload {
  const record = context.record(
    value,
    path,
    ['protocolVersion', 'sessionId', 'pageClientId', 'timestamp', 'sourceId', 'tagName'],
    ['componentName', 'controlFlow']
  );
  if (
    !record ||
    !validateViteContext(context, record, path) ||
    !validateSourceIdValue(context, record.sourceId, `${path}.sourceId`) ||
    !context.string(record.tagName, `${path}.tagName`, 1, PROTOCOL_LIMITS.labelLength)
  ) {
    return false;
  }
  if (
    record.componentName !== undefined &&
    !context.string(
      record.componentName,
      `${path}.componentName`,
      1,
      PROTOCOL_LIMITS.labelLength
    )
  ) {
    return false;
  }
  if (
    record.controlFlow !== undefined &&
    !context.enum(record.controlFlow, `${path}.controlFlow`, [
      'for',
      'if',
      'else-if',
      'else'
    ])
  ) {
    return false;
  }
  return true;
}

function validateServerResultValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ServerResultPayload {
  const record = context.record(
    value,
    path,
    ['protocolVersion', 'sessionId', 'pageClientId', 'timestamp', 'ok'],
    ['requestId', 'code', 'message']
  );
  if (
    !record ||
    !validateViteContext(context, record, path) ||
    !context.boolean(record.ok, `${path}.ok`)
  ) {
    return false;
  }
  if (
    record.requestId !== undefined &&
    !validateSafeId(
      context,
      record.requestId,
      `${path}.requestId`,
      PROTOCOL_LIMITS.messageIdLength
    )
  ) {
    return false;
  }
  if (
    record.code !== undefined &&
    !context.enum(record.code, `${path}.code`, PROTOCOL_ERROR_CODES)
  ) {
    return false;
  }
  return (
    record.message === undefined ||
    context.string(
      record.message,
      `${path}.message`,
      1,
      PROTOCOL_LIMITS.errorMessageLength
    )
  );
}

function validateSessionRoot(
  context: ValidationContext,
  value: unknown,
  path: string
): value is SessionRootDescriptor {
  const record = context.record(value, path, [
    'rootKey',
    'canonicalPath',
    'displayName'
  ]);
  if (
    !record ||
    !validateSafeId(
      context,
      record.rootKey,
      `${path}.rootKey`,
      PROTOCOL_LIMITS.rootKeyLength
    ) ||
    !context.string(
      record.canonicalPath,
      `${path}.canonicalPath`,
      1,
      PROTOCOL_LIMITS.canonicalPathLength
    )
  ) {
    return false;
  }
  if (CONTROL_CHARACTER_PATTERN.test(record.canonicalPath as string)) {
    return context.fail(`${path}.canonicalPath`, '本机路径不能包含控制字符');
  }
  return context.string(
    record.displayName,
    `${path}.displayName`,
    1,
    PROTOCOL_LIMITS.labelLength
  );
}

function validateSessionRoots(
  context: ValidationContext,
  value: unknown,
  path: string
): value is SessionRootDescriptor[] {
  const roots = context.array(value, path, PROTOCOL_LIMITS.workspaceRootCount);
  if (!roots || roots.length === 0) {
    if (roots) {
      context.fail(path, '至少需要一个 workspace root');
    }
    return false;
  }
  const rootKeys = new Set<string>();
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    if (!validateSessionRoot(context, root, `${path}[${index}]`)) {
      return false;
    }
    if (rootKeys.has(root.rootKey)) {
      return context.fail(`${path}[${index}].rootKey`, 'rootKey 不能重复');
    }
    rootKeys.add(root.rootKey);
  }
  return true;
}

function validateOrigins(
  context: ValidationContext,
  value: unknown,
  path: string
): value is string[] {
  const origins = context.array(value, path, PROTOCOL_LIMITS.originCount);
  if (!origins) {
    return false;
  }
  return origins.every((origin, index) =>
    validateOrigin(context, origin, `${path}[${index}]`)
  );
}

function validateBrowserTab(
  context: ValidationContext,
  value: unknown,
  path: string
): boolean {
  const record = context.record(value, path, [
    'pageClientId',
    'pathname',
    'title',
    'connectedAt'
  ]);
  if (
    !record ||
    !validateSafeId(
      context,
      record.pageClientId,
      `${path}.pageClientId`,
      PROTOCOL_LIMITS.clientIdLength
    ) ||
    !validatePathname(context, record.pathname, `${path}.pathname`) ||
    !context.string(record.title, `${path}.title`, 0, PROTOCOL_LIMITS.labelLength) ||
    !validateTimestamp(context, record.connectedAt, `${path}.connectedAt`)
  ) {
    return false;
  }
  return true;
}

function validateIdeWorkspaceRoots(
  context: ValidationContext,
  value: unknown,
  path: string
): boolean {
  const roots = context.array(value, path, PROTOCOL_LIMITS.workspaceRootCount);
  if (!roots) {
    return false;
  }
  return roots.every((root, index) => {
    const rootPath = `${path}[${index}]`;
    const record = context.record(root, rootPath, ['canonicalPath'], ['rootKey']);
    if (
      !record ||
      !context.string(
        record.canonicalPath,
        `${rootPath}.canonicalPath`,
        1,
        PROTOCOL_LIMITS.canonicalPathLength
      ) ||
      CONTROL_CHARACTER_PATTERN.test(record.canonicalPath as string)
    ) {
      return record && CONTROL_CHARACTER_PATTERN.test(record.canonicalPath as string)
        ? context.fail(`${rootPath}.canonicalPath`, '本机路径不能包含控制字符')
        : false;
    }
    return record.rootKey === undefined ||
      validateSafeId(
        context,
        record.rootKey,
        `${rootPath}.rootKey`,
        PROTOCOL_LIMITS.rootKeyLength
      );
  });
}

function validateIdeHelloValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is IdeHelloPayload {
  const record = context.record(value, path, [
    'ideClientId',
    'ideName',
    'extensionVersion',
    'workspaceRoots',
    'capabilities',
    'focused'
  ]);
  return Boolean(
    record &&
      validateSafeId(
        context,
        record.ideClientId,
        `${path}.ideClientId`,
        PROTOCOL_LIMITS.clientIdLength
      ) &&
      context.string(
        record.ideName,
        `${path}.ideName`,
        1,
        PROTOCOL_LIMITS.labelLength
      ) &&
      context.string(
        record.extensionVersion,
        `${path}.extensionVersion`,
        1,
        PROTOCOL_LIMITS.versionLength
      ) &&
      validateIdeWorkspaceRoots(context, record.workspaceRoots, `${path}.workspaceRoots`) &&
      validateStringArray(
        context,
        record.capabilities,
        `${path}.capabilities`,
        PROTOCOL_LIMITS.capabilityCount,
        PROTOCOL_LIMITS.capabilityLength
      ) &&
      context.boolean(record.focused, `${path}.focused`)
  );
}

function validateBridgeSessionSummary(
  context: ValidationContext,
  value: unknown,
  path: string
): boolean {
  const record = context.record(value, path, [
    'sessionId',
    'projectName',
    'canonicalRoots',
    'capabilities'
  ]);
  if (
    !record ||
    !validateSafeId(
      context,
      record.sessionId,
      `${path}.sessionId`,
      PROTOCOL_LIMITS.sessionIdLength
    ) ||
    !context.string(
      record.projectName,
      `${path}.projectName`,
      1,
      PROTOCOL_LIMITS.labelLength
    ) ||
    !validateStringArray(
      context,
      record.capabilities,
      `${path}.capabilities`,
      PROTOCOL_LIMITS.capabilityCount,
      PROTOCOL_LIMITS.capabilityLength
    )
  ) {
    return false;
  }
  const roots = context.array(
    record.canonicalRoots,
    `${path}.canonicalRoots`,
    PROTOCOL_LIMITS.workspaceRootCount
  );
  if (!roots || roots.length === 0) {
    return roots ? context.fail(`${path}.canonicalRoots`, '至少需要一个 root') : false;
  }
  return roots.every((root, index) => {
    const rootPath = `${path}.canonicalRoots[${index}]`;
    const rootRecord = context.record(root, rootPath, ['rootKey', 'displayName']);
    if (
      !rootRecord ||
      !validateSafeId(
        context,
        rootRecord.rootKey,
        `${rootPath}.rootKey`,
        PROTOCOL_LIMITS.rootKeyLength
      )
    ) {
      return false;
    }
    return context.string(
      rootRecord.displayName,
      `${rootPath}.displayName`,
      1,
      PROTOCOL_LIMITS.labelLength
    );
  });
}

function validateServerHelloAckValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ServerHelloAckPayload {
  const record = context.record(value, path, [
    'authenticated',
    'session',
    'browserTabs'
  ]);
  if (record && record.authenticated !== true) {
    context.fail(`${path}.authenticated`, 'hello ack 必须明确认证成功');
  }
  if (
    !record ||
    context.error ||
    !validateBridgeSessionSummary(context, record.session, `${path}.session`)
  ) {
    return false;
  }
  const tabs = context.array(
    record.browserTabs,
    `${path}.browserTabs`,
    PROTOCOL_LIMITS.browserTabCount
  );
  if (
    !tabs ||
    !tabs.every((tab, index) =>
      validateBrowserTab(context, tab, `${path}.browserTabs[${index}]`)
    )
  ) {
    return false;
  }
  return true;
}

function validateIdeClaimValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is IdeClaimPayload {
  const record = context.record(value, path, ['claim']);
  return Boolean(record && context.boolean(record.claim, `${path}.claim`));
}

function validateServerClaimResultValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ServerClaimResultPayload {
  const record = context.record(value, path, ['claimed']);
  return Boolean(
    record && context.boolean(record.claimed, `${path}.claimed`)
  );
}

function validateIdeFocusValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is IdeFocusPayload {
  const record = context.record(value, path, ['focused']);
  return Boolean(record && context.boolean(record.focused, `${path}.focused`));
}

function validateHeartbeatValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is HeartbeatPayload {
  const record = context.record(value, path, [], ['acknowledged', 'serverTime']);
  if (!record) {
    return false;
  }
  if (record.acknowledged !== undefined && record.acknowledged !== true) {
    return context.fail(`${path}.acknowledged`, 'acknowledged 只能为 true');
  }
  return record.serverTime === undefined ||
    validateTimestamp(context, record.serverTime, `${path}.serverTime`);
}

function validateOptionalContext(
  context: ValidationContext,
  value: unknown,
  path: string
): boolean {
  return context.string(value, path, 0, PROTOCOL_LIMITS.contextLength) &&
    !(value as string).includes('\u0000')
    ? true
    : context.error
      ? false
      : context.fail(path, '上下文不能包含 NUL');
}

function validateNullableContext(
  context: ValidationContext,
  value: unknown,
  path: string
): boolean {
  return value === null || validateOptionalContext(context, value, path);
}

function validateOpenSourceCandidate(
  context: ValidationContext,
  value: unknown,
  path: string
): value is OpenSourceCandidate {
  const record = context.record(
    value,
    path,
    [
      'candidateKind',
      'rootKey',
      'relativePath',
      'range',
      'sourceDigest',
      'accuracy',
      'label'
    ],
    ['contextBefore', 'contextAfter']
  );
  if (
    !record ||
    !context.enum(
      record.candidateKind,
      `${path}.candidateKind`,
      CANDIDATE_KINDS
    ) ||
    !validateSafeId(
      context,
      record.rootKey,
      `${path}.rootKey`,
      PROTOCOL_LIMITS.rootKeyLength
    ) ||
    !validateWireRelativePathValue(
      context,
      record.relativePath,
      `${path}.relativePath`
    ) ||
    !validateSourceRangeValue(context, record.range, `${path}.range`) ||
    !context.string(
      record.sourceDigest,
      `${path}.sourceDigest`,
      71,
      71,
      DIGEST_PATTERN
    ) ||
    !context.enum(record.accuracy, `${path}.accuracy`, ['exact', 'approximate']) ||
    !context.string(record.label, `${path}.label`, 1, PROTOCOL_LIMITS.labelLength)
  ) {
    return false;
  }
  if (
    record.contextBefore !== undefined &&
    !validateNullableContext(context, record.contextBefore, `${path}.contextBefore`)
  ) {
    return false;
  }
  return (
    record.contextAfter === undefined ||
    validateNullableContext(context, record.contextAfter, `${path}.contextAfter`)
  );
}

function validateServerOpenSourceValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ServerOpenSourcePayload {
  const record = context.record(
    value,
    path,
    [
      'openRequestId',
      'pageClientId',
      'page',
      'candidateKind',
      'rootKey',
      'relativePath',
      'range',
      'sourceDigest',
      'accuracy',
      'tagName',
      'componentName',
      'contextBefore',
      'contextAfter'
    ],
    ['candidates']
  );
  if (
    !record ||
    !validateSafeId(
      context,
      record.openRequestId,
      `${path}.openRequestId`,
      PROTOCOL_LIMITS.messageIdLength
    ) ||
    !validateSafeId(
      context,
      record.pageClientId,
      `${path}.pageClientId`,
      PROTOCOL_LIMITS.clientIdLength
    ) ||
    !validateSafeId(
      context,
      record.rootKey,
      `${path}.rootKey`,
      PROTOCOL_LIMITS.rootKeyLength
    ) ||
    !validateWireRelativePathValue(
      context,
      record.relativePath,
      `${path}.relativePath`
    ) ||
    !validateSourceRangeValue(context, record.range, `${path}.range`) ||
    !context.string(
      record.sourceDigest,
      `${path}.sourceDigest`,
      71,
      71,
      DIGEST_PATTERN
    ) ||
    !validateNullableContext(
      context,
      record.contextBefore,
      `${path}.contextBefore`
    ) ||
    !validateNullableContext(
      context,
      record.contextAfter,
      `${path}.contextAfter`
    ) ||
    !context.enum(record.accuracy, `${path}.accuracy`, ['exact', 'approximate']) ||
    !context.string(
      record.candidateKind,
      `${path}.candidateKind`,
      1,
      PROTOCOL_LIMITS.capabilityLength,
      SAFE_ID_PATTERN
    ) ||
    !context.string(
      record.tagName,
      `${path}.tagName`,
      1,
      PROTOCOL_LIMITS.labelLength
    )
  ) {
    return false;
  }
  if (
    record.componentName !== null &&
    !context.string(
      record.componentName,
      `${path}.componentName`,
      1,
      PROTOCOL_LIMITS.labelLength
    )
  ) {
    return false;
  }
  const page = context.record(
    record.page,
    `${path}.page`,
    ['origin', 'pathname', 'title']
  );
  if (
    !page ||
    !validateOrigin(context, page.origin, `${path}.page.origin`) ||
    !validatePathname(context, page.pathname, `${path}.page.pathname`)
  ) {
    return false;
  }
  if (!context.string(
    page.title,
    `${path}.page.title`,
    0,
    PROTOCOL_LIMITS.labelLength
  )) {
    return false;
  }
  if (record.candidates === undefined) {
    return true;
  }
  const candidates = context.array(
    record.candidates,
    `${path}.candidates`,
    PROTOCOL_LIMITS.candidateCount
  );
  return Boolean(candidates?.every((candidate, index) => validateOpenSourceCandidate(
    context,
    candidate,
    `${path}.candidates[${index}]`
  )));
}

function validateIdeOpenResultValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is IdeOpenResultPayload {
  const record = context.record(
    value,
    path,
    ['requestMessageId', 'ok'],
    ['accuracy', 'relativePath', 'line', 'code', 'message']
  );
  if (
    !record ||
    !validateSafeId(
      context,
      record.requestMessageId,
      `${path}.requestMessageId`,
      PROTOCOL_LIMITS.messageIdLength
    ) ||
    !context.boolean(record.ok, `${path}.ok`)
  ) {
    return false;
  }
  if (
    record.accuracy !== undefined &&
    !context.enum(record.accuracy, `${path}.accuracy`, ['exact', 'approximate'])
  ) {
    return false;
  }
  if (
    record.relativePath !== undefined &&
    !validateWireRelativePathValue(
      context,
      record.relativePath,
      `${path}.relativePath`
    )
  ) {
    return false;
  }
  if (
    record.line !== undefined &&
    !context.integer(record.line, `${path}.line`, 1)
  ) {
    return false;
  }
  if (
    record.code !== undefined &&
    !context.enum(record.code, `${path}.code`, PROTOCOL_ERROR_CODES)
  ) {
    return false;
  }
  if (
    record.message !== undefined &&
    !context.string(
      record.message,
      `${path}.message`,
      1,
      PROTOCOL_LIMITS.errorMessageLength
    )
  ) {
    return false;
  }
  return true;
}

function validateIdeSetBrowserModeValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is IdeSetBrowserModePayload {
  const record = context.record(value, path, ['enabled'], ['pageClientId']);
  if (!record || !context.boolean(record.enabled, `${path}.enabled`)) {
    return false;
  }
  return record.pageClientId === undefined ||
    validateSafeId(
      context,
      record.pageClientId,
      `${path}.pageClientId`,
      PROTOCOL_LIMITS.clientIdLength
    );
}

function validateServerTabsChangedValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ServerTabsChangedPayload {
  const record = context.record(value, path, ['browserTabs']);
  if (!record) {
    return false;
  }
  const tabs = context.array(
    record.browserTabs,
    `${path}.browserTabs`,
    PROTOCOL_LIMITS.browserTabCount
  );
  return Boolean(
    tabs &&
      tabs.every((tab, index) =>
        validateBrowserTab(context, tab, `${path}.browserTabs[${index}]`)
      )
  );
}

function validateSessionDisposeValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ServerSessionDisposePayload {
  const record = context.record(value, path, ['reason']);
  return Boolean(
    record &&
      context.enum(record.reason, `${path}.reason`, [
        'dev-server-closed',
        'restart',
        'expired'
      ])
  );
}

function validateErrorValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is ErrorPayload {
  const record = context.record(
    value,
    path,
    ['code'],
    ['requestMessageId', 'message']
  );
  if (
    !record ||
    !context.enum(record.code, `${path}.code`, PROTOCOL_ERROR_CODES)
  ) {
    return false;
  }
  if (
    record.requestMessageId !== undefined &&
    !validateSafeId(
      context,
      record.requestMessageId,
      `${path}.requestMessageId`,
      PROTOCOL_LIMITS.messageIdLength
    )
  ) {
    return false;
  }
  return record.message === undefined ||
    context.string(
      record.message,
      `${path}.message`,
      1,
      PROTOCOL_LIMITS.errorMessageLength
    );
}

function validateBridgePayload(
  context: ValidationContext,
  type: BridgeMessageType,
  value: unknown,
  path: string
): value is BridgePayloadMap[BridgeMessageType] {
  switch (type) {
    case 'ide:hello':
      return validateIdeHelloValue(context, value, path);
    case 'server:hello-ack':
      return validateServerHelloAckValue(context, value, path);
    case 'ide:claim':
      return validateIdeClaimValue(context, value, path);
    case 'server:claim-result':
      return validateServerClaimResultValue(context, value, path);
    case 'ide:focus':
      return validateIdeFocusValue(context, value, path);
    case 'heartbeat':
      return validateHeartbeatValue(context, value, path);
    case 'server:open-source':
      return validateServerOpenSourceValue(context, value, path);
    case 'ide:open-result':
      return validateIdeOpenResultValue(context, value, path);
    case 'ide:set-browser-mode':
      return validateIdeSetBrowserModeValue(context, value, path);
    case 'server:tabs-changed':
      return validateServerTabsChangedValue(context, value, path);
    case 'server:session-dispose':
      return validateSessionDisposeValue(context, value, path);
    case 'error':
      return validateErrorValue(context, value, path);
  }
}

function parseJson(
  serialized: string,
  maximumBytes: number
): ProtocolValidationResult<unknown> {
  if (typeof serialized !== 'string') {
    return failure({
      code: 'INVALID_MESSAGE',
      path: '$',
      message: '只接受 UTF-8 JSON 文本消息'
    });
  }
  if (utf8ByteLength(serialized) > maximumBytes) {
    return failure({
      code: 'MESSAGE_TOO_LARGE',
      path: '$',
      message: `消息不能超过 ${maximumBytes} bytes`
    });
  }
  try {
    return success(JSON.parse(serialized) as unknown);
  } catch {
    return failure({
      code: 'INVALID_MESSAGE',
      path: '$',
      message: '消息不是合法 JSON'
    });
  }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isProtocolVersionCompatible(version: string): boolean {
  return /^\d+\.\d+$/.test(version) && Number(version.split('.', 1)[0]) === PROTOCOL_MAJOR;
}

export function getSourceIdError(value: string): string | undefined {
  if (value.length < PROTOCOL_LIMITS.sourceIdMinLength) {
    return `sourceId 不能少于 ${PROTOCOL_LIMITS.sourceIdMinLength} 个字符`;
  }
  if (value.length > PROTOCOL_LIMITS.sourceIdMaxLength) {
    return `sourceId 不能超过 ${PROTOCOL_LIMITS.sourceIdMaxLength} 个字符`;
  }
  if (!SOURCE_ID_PATTERN.test(value)) {
    return 'sourceId 必须只包含 Base64URL 字符';
  }
  return undefined;
}

export function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && getSourceIdError(value) === undefined;
}

function validateSourceIdValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is string {
  if (typeof value !== 'string') {
    return context.fail(path, '必须是字符串');
  }
  const reason = getSourceIdError(value);
  return reason ? context.fail(path, reason) : true;
}

export function getWireRelativePathError(value: string): string | undefined {
  if (value.length === 0) {
    return '路径不能为空';
  }
  if (value.length > PROTOCOL_LIMITS.relativePathLength) {
    return `路径不能超过 ${PROTOCOL_LIMITS.relativePathLength} 个字符`;
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return '路径不能包含 NUL 或控制字符';
  }
  if (value.includes('\\')) {
    return '协议路径只能使用 POSIX 分隔符';
  }
  if (value.startsWith('/') || value.startsWith('//')) {
    return '协议路径不能是绝对路径或 UNC 路径';
  }
  if (value.startsWith('~')) {
    return '协议路径不能使用用户目录表达式';
  }
  if (value.includes(':') || /^file:/i.test(value)) {
    return '协议路径不能包含 URI scheme 或盘符';
  }
  if (/%[0-9a-f]{2}/i.test(value)) {
    return '协议路径不能依赖 URL decode';
  }

  const segments = value.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      return '协议路径不能包含空、点或父级路径段';
    }
    if (segment.length > 255) {
      return '单个路径段不能超过 255 个字符';
    }
    if (/[. ]$/.test(segment)) {
      return 'Windows 路径段不能以点或空格结尾';
    }
    if (WINDOWS_RESERVED_SEGMENT_PATTERN.test(segment)) {
      return '协议路径不能包含 Windows 设备名';
    }
  }
  return undefined;
}

export function isWireRelativePath(value: string): boolean {
  return getWireRelativePathError(value) === undefined;
}

function validateWireRelativePathValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is string {
  if (typeof value !== 'string') {
    return context.fail(path, '必须是字符串');
  }
  const reason = getWireRelativePathError(value);
  return reason ? context.fail(path, reason) : true;
}

export function validateSourceRange(
  value: unknown
): ProtocolValidationResult<SourceRange> {
  const context = new ValidationContext();
  validateSourceRangeValue(context, value, '$');
  return resultFromContext<SourceRange>(context, value);
}

export function validateBridgeMessage(
  value: unknown
): ProtocolValidationResult<BridgeMessage> {
  const context = new ValidationContext();
  const record = context.record(value, '$', [
    'protocolVersion',
    'messageId',
    'type',
    'sessionId',
    'senderId',
    'timestamp',
    'payload'
  ]);
  if (!record) {
    return resultFromContext<BridgeMessage>(context, value);
  }
  if (
    !validateProtocolVersionValue(
      context,
      record.protocolVersion,
      '$.protocolVersion'
    ) ||
    !validateSafeId(
      context,
      record.messageId,
      '$.messageId',
      PROTOCOL_LIMITS.messageIdLength
    ) ||
    !validateSafeId(
      context,
      record.sessionId,
      '$.sessionId',
      PROTOCOL_LIMITS.sessionIdLength
    ) ||
    !validateSafeId(
      context,
      record.senderId,
      '$.senderId',
      PROTOCOL_LIMITS.clientIdLength
    ) ||
    !validateTimestamp(context, record.timestamp, '$.timestamp')
  ) {
    return resultFromContext<BridgeMessage>(context, value);
  }
  if (
    typeof record.type !== 'string' ||
    !BRIDGE_MESSAGE_TYPES.includes(record.type as BridgeMessageType)
  ) {
    context.fail('$.type', '未知 Bridge 消息类型', 'UNKNOWN_MESSAGE_TYPE');
    return resultFromContext<BridgeMessage>(context, value);
  }
  validateBridgePayload(
    context,
    record.type as BridgeMessageType,
    record.payload,
    '$.payload'
  );
  return resultFromContext<BridgeMessage>(context, value);
}

export function parseBridgeMessage(
  serialized: string
): ProtocolValidationResult<BridgeMessage> {
  const parsed = parseJson(serialized, PROTOCOL_LIMITS.bridgeMessageBytes);
  return parsed.ok ? validateBridgeMessage(parsed.value) : parsed;
}

export function validateBrowserToServerPayload<TEvent extends BrowserToServerEvent>(
  event: TEvent,
  value: unknown
): ProtocolValidationResult<BrowserToServerPayloadMap[TEvent]> {
  const context = new ValidationContext();
  switch (event) {
    case 'wsi:browser:hello':
      validateBrowserHelloValue(context, value, '$');
      break;
    case 'wsi:browser:heartbeat':
      validateBrowserHeartbeatValue(context, value, '$');
      break;
    case 'wsi:browser:select':
      validateBrowserSelectValue(context, value, '$');
      break;
    case 'wsi:browser:metadata-request':
      validateBrowserMetadataRequestValue(context, value, '$');
      break;
    case 'wsi:browser:dispose':
      validateBrowserDisposeValue(context, value, '$');
      break;
    default:
      context.fail('$event', '未知 Browser → Server 事件', 'UNKNOWN_MESSAGE_TYPE');
  }
  return resultFromContext<BrowserToServerPayloadMap[TEvent]>(context, value);
}

export function parseBrowserToServerPayload<TEvent extends BrowserToServerEvent>(
  event: TEvent,
  serialized: string
): ProtocolValidationResult<BrowserToServerPayloadMap[TEvent]> {
  const parsed = parseJson(serialized, PROTOCOL_LIMITS.browserMessageBytes);
  return parsed.ok
    ? validateBrowserToServerPayload(event, parsed.value)
    : parsed;
}

export function validateServerToBrowserPayload<TEvent extends ServerToBrowserEvent>(
  event: TEvent,
  value: unknown
): ProtocolValidationResult<ServerToBrowserPayloadMap[TEvent]> {
  const context = new ValidationContext();
  switch (event) {
    case 'wsi:server:heartbeat':
      validateServerHeartbeatValue(context, value, '$');
      break;
    case 'wsi:browser:set-mode':
      validateServerSetModeValue(context, value, '$');
      break;
    case 'wsi:browser:connection':
      validateServerConnectionValue(context, value, '$');
      break;
    case 'wsi:browser:metadata':
      validateServerMetadataValue(context, value, '$');
      break;
    case 'wsi:browser:result':
      validateServerResultValue(context, value, '$');
      break;
    default:
      context.fail('$event', '未知 Server → Browser 事件', 'UNKNOWN_MESSAGE_TYPE');
  }
  return resultFromContext<ServerToBrowserPayloadMap[TEvent]>(context, value);
}

export function parseServerToBrowserPayload<TEvent extends ServerToBrowserEvent>(
  event: TEvent,
  serialized: string
): ProtocolValidationResult<ServerToBrowserPayloadMap[TEvent]> {
  const parsed = parseJson(serialized, PROTOCOL_LIMITS.browserMessageBytes);
  return parsed.ok ? validateServerToBrowserPayload(event, parsed.value) : parsed;
}

/** @deprecated 使用 validateBrowserToServerPayload。 */
export function validateBrowserToVitePayload<TEvent extends BrowserToViteEvent>(
  event: TEvent,
  value: unknown
): ProtocolValidationResult<BrowserToVitePayloadMap[TEvent]> {
  return validateBrowserToServerPayload(event, value);
}

/** @deprecated 使用 parseBrowserToServerPayload。 */
export function parseBrowserToVitePayload<TEvent extends BrowserToViteEvent>(
  event: TEvent,
  serialized: string
): ProtocolValidationResult<BrowserToVitePayloadMap[TEvent]> {
  return parseBrowserToServerPayload(event, serialized);
}

/** @deprecated 使用 validateServerToBrowserPayload。 */
export function validateViteToBrowserPayload<TEvent extends ViteToBrowserEvent>(
  event: TEvent,
  value: unknown
): ProtocolValidationResult<ViteToBrowserPayloadMap[TEvent]> {
  return validateServerToBrowserPayload(event, value);
}

/** @deprecated 使用 parseServerToBrowserPayload。 */
export function parseViteToBrowserPayload<TEvent extends ViteToBrowserEvent>(
  event: TEvent,
  serialized: string
): ProtocolValidationResult<ViteToBrowserPayloadMap[TEvent]> {
  return parseServerToBrowserPayload(event, serialized);
}

export function validateSessionDescriptor(
  value: unknown
): ProtocolValidationResult<SessionDescriptor> {
  const context = new ValidationContext();
  const record = context.record(value, '$', [
    'schemaVersion',
    'protocolVersion',
    'sessionId',
    'pid',
    'port',
    'bridgePath',
    'token',
    'createdAt',
    'heartbeatAt',
    'projectName',
    'canonicalRoots',
    'devOrigins',
    'capabilities'
  ]);
  if (!record) {
    return resultFromContext<SessionDescriptor>(context, value);
  }
  if (record.schemaVersion !== SESSION_SCHEMA_VERSION) {
    context.fail('$.schemaVersion', '不支持的 session schema 版本');
  } else if (
    validateProtocolVersionValue(context, record.protocolVersion, '$.protocolVersion') &&
    validateSafeId(
      context,
      record.sessionId,
      '$.sessionId',
      PROTOCOL_LIMITS.sessionIdLength
    ) &&
    context.integer(record.pid, '$.pid', 1) &&
    context.integer(record.port, '$.port', 1, 65_535) &&
    context.string(
      record.bridgePath,
      '$.bridgePath',
      2,
      PROTOCOL_LIMITS.bridgePathLength,
      /^\/[A-Za-z0-9/_-]+$/
    ) &&
    context.string(
      record.token,
      '$.token',
      32,
      PROTOCOL_LIMITS.tokenLength,
      /^[A-Za-z0-9_-]+$/
    ) &&
    validateTimestamp(context, record.createdAt, '$.createdAt') &&
    validateTimestamp(context, record.heartbeatAt, '$.heartbeatAt') &&
    context.string(
      record.projectName,
      '$.projectName',
      1,
      PROTOCOL_LIMITS.labelLength
    ) &&
    validateSessionRoots(context, record.canonicalRoots, '$.canonicalRoots') &&
    validateOrigins(context, record.devOrigins, '$.devOrigins')
  ) {
    validateStringArray(
      context,
      record.capabilities,
      '$.capabilities',
      PROTOCOL_LIMITS.capabilityCount,
      PROTOCOL_LIMITS.capabilityLength
    );
  }
  return resultFromContext<SessionDescriptor>(context, value);
}

export function parseSessionDescriptor(
  serialized: string
): ProtocolValidationResult<SessionDescriptor> {
  const parsed = parseJson(serialized, PROTOCOL_LIMITS.sessionDescriptorBytes);
  return parsed.ok ? validateSessionDescriptor(parsed.value) : parsed;
}

function validateCliJsonDiagnosticValue(
  context: ValidationContext,
  value: unknown,
  path: string
): value is CliJsonDiagnostic {
  const record = context.record(
    value,
    path,
    ['code', 'severity', 'message'],
    ['file']
  );
  if (
    !record ||
    !context.string(
      record.code,
      `${path}.code`,
      1,
      PROTOCOL_LIMITS.capabilityLength,
      SAFE_ID_PATTERN
    ) ||
    !context.enum(record.severity, `${path}.severity`, [
      'info',
      'warning',
      'error'
    ]) ||
    !context.string(
      record.message,
      `${path}.message`,
      1,
      PROTOCOL_LIMITS.errorMessageLength
    )
  ) {
    return false;
  }
  return record.file === undefined ||
    validateWireRelativePathValue(context, record.file, `${path}.file`);
}

export function validateCliJsonEnvelope(
  value: unknown
): ProtocolValidationResult<CliJsonEnvelope> {
  const context = new ValidationContext();
  const record = context.record(value, '$', [
    'schemaVersion',
    'protocolVersion',
    'operation',
    'ok',
    'result',
    'diagnostics',
    'errorCode'
  ]);
  if (!record) {
    return resultFromContext<CliJsonEnvelope>(context, value);
  }
  if (record.schemaVersion !== CLI_JSON_SCHEMA_VERSION) {
    context.fail('$.schemaVersion', '不支持的 CLI JSON schema 版本');
  } else if (
    validateProtocolVersionValue(context, record.protocolVersion, '$.protocolVersion') &&
    context.enum(record.operation, '$.operation', CLI_JSON_OPERATIONS) &&
    context.boolean(record.ok, '$.ok')
  ) {
    if (
      record.errorCode !== null &&
      !context.enum(record.errorCode, '$.errorCode', PROTOCOL_ERROR_CODES)
    ) {
      return resultFromContext<CliJsonEnvelope>(context, value);
    }
    if (record.ok && record.errorCode !== null) {
      context.fail('$.errorCode', '成功 envelope 的 errorCode 必须为 null');
    } else if (!record.ok && record.errorCode === null) {
      context.fail('$.errorCode', '失败 envelope 必须提供稳定 errorCode');
    }
    const diagnostics = context.array(
      record.diagnostics,
      '$.diagnostics',
      PROTOCOL_LIMITS.diagnosticCount
    );
    diagnostics?.forEach((diagnostic, index) => {
      if (!context.error) {
        validateCliJsonDiagnosticValue(
          context,
          diagnostic,
          `$.diagnostics[${index}]`
        );
      }
    });
  }
  return resultFromContext<CliJsonEnvelope>(context, value);
}

export function parseCliJsonEnvelope(
  serialized: string
): ProtocolValidationResult<CliJsonEnvelope> {
  const parsed = parseJson(serialized, PROTOCOL_LIMITS.cliJsonBytes);
  return parsed.ok ? validateCliJsonEnvelope(parsed.value) : parsed;
}

export function createProtocolEnvelope<TType extends BridgeMessageType>(
  type: TType,
  payload: BridgePayloadMap[TType],
  options: {
    messageId: string;
    sessionId: string;
    senderId: string;
    timestamp?: number;
    protocolVersion?: ProtocolVersion;
  }
): import('./types').ProtocolEnvelope<TType, BridgePayloadMap[TType]> {
  return {
    protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    messageId: options.messageId,
    type,
    sessionId: options.sessionId,
    senderId: options.senderId,
    timestamp: options.timestamp ?? Date.now(),
    payload
  };
}
