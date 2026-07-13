export const PROTOCOL_VERSION = '1.0' as const;
export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;
export const BRIDGE_SUBPROTOCOL = 'wsi.bridge.v1' as const;
export const SESSION_SCHEMA_VERSION = 1 as const;
export const CLI_JSON_SCHEMA_VERSION = 1 as const;
export const BROWSER_TOKEN_AUDIENCE = 'browser-transport' as const;

// Browser token 只覆盖一个短期页面连接，会话层可在更短周期主动轮换。
export const BROWSER_TOKEN_TTL_MS = 5 * 60 * 1000;
export const BROWSER_PAGE_TTL_MS = 3 * 60 * 1000;

export const BROWSER_EVENTS = {
  hello: 'wsi:browser:hello',
  heartbeat: 'wsi:browser:heartbeat',
  select: 'wsi:browser:select',
  metadataRequest: 'wsi:browser:metadata-request',
  dispose: 'wsi:browser:dispose',
  heartbeatAck: 'wsi:server:heartbeat',
  setMode: 'wsi:browser:set-mode',
  connection: 'wsi:browser:connection',
  metadata: 'wsi:browser:metadata',
  result: 'wsi:browser:result'
} as const;

export const PROTOCOL_LIMITS = {
  browserMessageBytes: 16 * 1024,
  bridgeMessageBytes: 64 * 1024,
  sessionDescriptorBytes: 64 * 1024,
  cliJsonBytes: 1024 * 1024,
  messageIdLength: 128,
  sourceIdLength: 43,
  sourceIdMinLength: 43,
  sourceIdMaxLength: 43,
  clientIdLength: 128,
  sessionIdLength: 128,
  rootKeyLength: 128,
  relativePathLength: 1024,
  canonicalPathLength: 4096,
  bridgePathLength: 256,
  tokenLength: 512,
  versionLength: 64,
  capabilityLength: 64,
  capabilityCount: 64,
  workspaceRootCount: 64,
  browserTabCount: 256,
  browserConnectionCount: 256,
  browserPendingRequestCount: 1024,
  candidateCount: 32,
  diagnosticCount: 256,
  originCount: 32,
  urlLength: 2048,
  labelLength: 256,
  contextLength: 256,
  errorMessageLength: 512,
  traceIdLength: 128
} as const;

export type BrowserEventName =
  (typeof BROWSER_EVENTS)[keyof typeof BROWSER_EVENTS];
