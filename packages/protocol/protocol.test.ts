import { describe, expect, it } from 'vitest';
import {
  BROWSER_TOKEN_AUDIENCE,
  CLI_JSON_SCHEMA_VERSION,
  PROTOCOL_LIMITS,
  createProtocolEnvelope,
  isSourceId,
  isProtocolVersionCompatible,
  isWireRelativePath,
  parseBridgeMessage,
  parseCliJsonEnvelope,
  parseSessionDescriptor,
  validateBrowserToServerPayload,
  validateBrowserToVitePayload,
  validateBridgeMessage,
  validateSourceRange,
  validateServerToBrowserPayload
} from './src/index';

const BROWSER_AUTH = {
  browserToken: 't'.repeat(43),
  tokenAudience: BROWSER_TOKEN_AUDIENCE,
} as const;

describe('protocol runtime validation', () => {
  it('accepts compatible minor versions and rejects another major', () => {
    expect(isProtocolVersionCompatible('1.8')).toBe(true);
    expect(isProtocolVersionCompatible('2.0')).toBe(false);

    const heartbeat = createProtocolEnvelope(
      'heartbeat',
      { sequence: 1, sentAt: 100 },
      {
        protocolVersion: '2.0',
        messageId: 'message-1',
        sessionId: 'session-1',
        senderId: 'ide-1',
        timestamp: 100
      }
    );
    expect(validateBridgeMessage(heartbeat)).toMatchObject({
      ok: false,
      error: { code: 'PROTOCOL_MISMATCH' }
    });
  });

  it('rejects unknown fields, unknown message types and binary input', () => {
    const heartbeat = {
      protocolVersion: '1.0',
      messageId: 'message-1',
      type: 'heartbeat',
      sessionId: 'session-1',
      senderId: 'ide-1',
      timestamp: 100,
      payload: { extra: true }
    };
    expect(validateBridgeMessage(heartbeat)).toMatchObject({
      ok: false,
      error: { path: '$.payload.extra' }
    });
    expect(validateBridgeMessage({ ...heartbeat, type: 'ide:execute' })).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_MESSAGE_TYPE' }
    });
    expect(parseBridgeMessage(new Uint8Array([1]) as never)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_MESSAGE' }
    });
  });

  it('enforces the raw Bridge byte limit', () => {
    const oversized = '中'.repeat(PROTOCOL_LIMITS.bridgeMessageBytes);
    expect(parseBridgeMessage(oversized)).toMatchObject({
      ok: false,
      error: { code: 'MESSAGE_TOO_LARGE' }
    });
  });

  it('validates browser selection fields and sourceId bounds', () => {
    const selection = {
      protocolVersion: '1.0',
      sessionId: 'session-1',
      pageClientId: 'page-1',
      ...BROWSER_AUTH,
      sourceId: 'a'.repeat(43),
      candidateKind: 'element',
      modifiers: { shift: false, alt: false },
      page: {
        origin: 'http://localhost:5173',
        pathname: '/dashboard',
        title: 'Dashboard'
      },
      timestamp: 100
    };
    expect(
      validateBrowserToVitePayload('wsi:browser:select', selection)
    ).toMatchObject({ ok: true });
    expect(
      validateBrowserToVitePayload('wsi:browser:select', {
        ...selection,
        sourceId: 'short'
      })
    ).toMatchObject({ ok: false, error: { path: '$.sourceId' } });
  });

  it('validates browser origins and pathnames independently', () => {
    const selection = {
      protocolVersion: '1.0',
      sessionId: 'session-1',
      pageClientId: 'page-1',
      ...BROWSER_AUTH,
      sourceId: 'a'.repeat(43),
      candidateKind: 'element',
      modifiers: { shift: false, alt: false },
      page: {
        origin: 'http://localhost:5173',
        pathname: '/dashboard',
        title: ''
      },
      timestamp: 100
    };

    expect(
      validateBrowserToVitePayload('wsi:browser:select', selection)
    ).toMatchObject({ ok: true });
    expect(
      validateBrowserToVitePayload('wsi:browser:select', {
        ...selection,
        page: { ...selection.page, origin: 'http://localhost:5173/path' }
      })
    ).toMatchObject({ ok: false, error: { path: '$.page.origin' } });
    expect(
      validateBrowserToVitePayload('wsi:browser:select', {
        ...selection,
        page: { ...selection.page, pathname: '/dashboard?admin=1' }
      })
    ).toMatchObject({ ok: false, error: { path: '$.page.pathname' } });
  });

  it('accepts the bundler-neutral browser and server payload contract', () => {
    const context = {
      protocolVersion: '1.0',
      sessionId: 'session-1',
      pageClientId: 'page-1',
      timestamp: 100
    };
    const browserContext = { ...context, ...BROWSER_AUTH };
    const page = {
      origin: 'http://localhost:5173',
      pathname: '/',
      title: 'Fixture'
    };

    expect(
      validateBrowserToServerPayload('wsi:browser:hello', {
        ...browserContext,
        runtimeVersion: '0.1.0',
        capabilities: ['metadata'],
        page
      })
    ).toMatchObject({ ok: true });
    expect(
      validateBrowserToServerPayload('wsi:browser:dispose', {
        ...browserContext,
        reason: 'hmr'
      })
    ).toMatchObject({ ok: true });
    expect(
      validateServerToBrowserPayload('wsi:browser:connection', {
        ...context,
        connected: true,
        ideName: 'Cursor'
      })
    ).toMatchObject({ ok: true });
    expect(
      validateServerToBrowserPayload('wsi:browser:metadata', {
        ...context,
        sourceId: 'a'.repeat(43),
        tagName: 'main',
        componentName: 'App',
        controlFlow: 'if'
      })
    ).toMatchObject({ ok: true });
    expect(
      validateServerToBrowserPayload('wsi:browser:result', {
        ...context,
        ok: false,
        code: 'SOURCE_STALE'
      })
    ).toMatchObject({ ok: true });
    expect(
      validateServerToBrowserPayload('wsi:browser:set-mode', {
        ...context,
        enabled: true
      })
    ).toMatchObject({ ok: true });
  });

  it('binds browser requests to the browser token audience and page', () => {
    const heartbeat = {
      protocolVersion: '1.0',
      sessionId: 'session-1',
      pageClientId: 'page-1',
      timestamp: 100,
      ...BROWSER_AUTH,
      sequence: 1,
    };

    expect(
      validateBrowserToServerPayload('wsi:browser:heartbeat', heartbeat),
    ).toMatchObject({ ok: true });
    expect(
      validateBrowserToServerPayload('wsi:browser:heartbeat', {
        ...heartbeat,
        tokenAudience: 'ide-bridge',
      }),
    ).toMatchObject({ ok: false, error: { path: '$.tokenAudience' } });
    const { browserToken: _browserToken, ...missingToken } = heartbeat;
    expect(
      validateBrowserToServerPayload('wsi:browser:heartbeat', missingToken),
    ).toMatchObject({ ok: false, error: { path: '$.browserToken' } });
    expect(
      validateServerToBrowserPayload('wsi:server:heartbeat', {
        protocolVersion: '1.0',
        sessionId: 'session-1',
        pageClientId: 'page-1',
        timestamp: 100,
        sequence: 1,
        acknowledged: true,
        serverTime: 101,
      }),
    ).toMatchObject({ ok: true });
  });

  it('rejects server-to-browser source paths and candidate positions', () => {
    const context = {
      protocolVersion: '1.0',
      sessionId: 'session-1',
      pageClientId: 'page-1',
      timestamp: 100,
    };
    expect(
      validateServerToBrowserPayload('wsi:browser:metadata', {
        ...context,
        sourceId: 'a'.repeat(43),
        tagName: 'main',
        relativePath: 'src/App.vue',
      }),
    ).toMatchObject({ ok: false, error: { path: '$.relativePath' } });
    expect(
      validateServerToBrowserPayload('wsi:browser:result', {
        ...context,
        ok: true,
        line: 10,
      }),
    ).toMatchObject({ ok: false, error: { path: '$.line' } });
  });

  it('parses the versioned CLI JSON envelope and stable init errors', () => {
    const envelope = {
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      protocolVersion: '1.0',
      operation: 'init:apply',
      ok: false,
      result: null,
      diagnostics: [
        {
          code: 'PLAN_STALE',
          severity: 'error',
          message: '配置已变化',
          file: 'vite.config.ts',
        },
      ],
      errorCode: 'PLAN_STALE',
    };

    expect(parseCliJsonEnvelope(JSON.stringify(envelope))).toMatchObject({
      ok: true,
    });
    expect(
      parseCliJsonEnvelope(
        JSON.stringify({ ...envelope, errorCode: 'UNSTABLE_CODE' }),
      ),
    ).toMatchObject({ ok: false, error: { path: '$.errorCode' } });
  });

  it('requires a complete 256-bit Base64URL sourceId', () => {
    expect(isSourceId('a'.repeat(43))).toBe(true);
    expect(isSourceId('a'.repeat(42))).toBe(false);
    expect(isSourceId('a'.repeat(44))).toBe(false);
    expect(isSourceId(`${'a'.repeat(42)}~`)).toBe(false);
  });

  it('rejects SourceRange values whose empty offsets and positions disagree', () => {
    const range = {
      startLine: 2,
      startColumn: 3,
      endLine: 2,
      endColumn: 3,
      startOffset: 10,
      endOffset: 10
    };

    expect(validateSourceRange(range)).toMatchObject({ ok: true });
    expect(
      validateSourceRange({ ...range, endColumn: 4 })
    ).toMatchObject({ ok: false, error: { path: '$' } });
    expect(
      validateSourceRange({ ...range, endOffset: 11 })
    ).toMatchObject({ ok: false, error: { path: '$' } });
  });

  it('parses a strict session descriptor without exposing alternate fields', () => {
    const descriptor = {
      schemaVersion: 1,
      protocolVersion: '1.0',
      sessionId: 'session-1',
      pid: 100,
      port: 45678,
      bridgePath: '/bridge/session-1',
      token: 'a'.repeat(43),
      createdAt: 100,
      heartbeatAt: 110,
      projectName: 'fixture',
      canonicalRoots: [
        {
          rootKey: 'root_fixture',
          canonicalPath: 'D:\\project\\fixture',
          displayName: 'fixture'
        }
      ],
      devOrigins: ['http://localhost:5173'],
      capabilities: ['vue', 'candidate']
    };
    expect(parseSessionDescriptor(JSON.stringify(descriptor))).toMatchObject({
      ok: true
    });
    expect(
      parseSessionDescriptor(JSON.stringify({ ...descriptor, command: 'code' }))
    ).toMatchObject({ ok: false, error: { path: '$.command' } });
  });

  it('accepts the bridge payloads used by Vite and the IDE extension', () => {
    const envelopeOptions = {
      messageId: 'message-1',
      sessionId: 'session-1',
      senderId: 'ide-1',
      timestamp: 100
    };
    const hello = createProtocolEnvelope(
      'ide:hello',
      {
        ideClientId: 'ide-1',
        ideName: 'Cursor',
        extensionVersion: '0.1.0',
        workspaceRoots: [
          { rootKey: 'root_fixture', canonicalPath: 'D:\\project\\fixture' }
        ],
        capabilities: ['open-source'],
        focused: true
      },
      envelopeOptions
    );
    const helloAck = createProtocolEnvelope(
      'server:hello-ack',
      {
        authenticated: true,
        session: {
          sessionId: 'session-1',
          projectName: 'fixture',
          canonicalRoots: [
            { rootKey: 'root_fixture', displayName: 'fixture' }
          ],
          capabilities: ['vue']
        },
        browserTabs: [
          {
            pageClientId: 'page-1',
            pathname: '/',
            title: 'Fixture',
            connectedAt: 100
          }
        ]
      },
      { ...envelopeOptions, senderId: 'session-1' }
    );
    const openSource = createProtocolEnvelope(
      'server:open-source',
      {
        openRequestId: 'request-1',
        pageClientId: 'page-1',
        rootKey: 'root_fixture',
        relativePath: 'src/App.vue',
        range: {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 6,
          startOffset: 0,
          endOffset: 5
        },
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        contextBefore: null,
        contextAfter: '\n',
        accuracy: 'exact',
        candidateKind: 'element',
        tagName: 'main',
        componentName: 'App',
        page: {
          origin: 'http://localhost:5173',
          pathname: '/',
          title: 'Fixture'
        }
      },
      { ...envelopeOptions, senderId: 'session-1' }
    );

    expect(validateBridgeMessage(hello)).toMatchObject({ ok: true });
    expect(validateBridgeMessage(helloAck)).toMatchObject({ ok: true });
    expect(validateBridgeMessage(openSource)).toMatchObject({ ok: true });
    expect(
      validateBridgeMessage(
        createProtocolEnvelope('ide:open-result', {
          requestMessageId: 'request-1',
          ok: true,
          relativePath: 'src/App.vue',
          line: 1,
          accuracy: 'exact'
        }, envelopeOptions)
      )
    ).toMatchObject({ ok: true });
  });
});

describe('wire paths', () => {
  it.each([
    '',
    '/src/App.vue',
    '../App.vue',
    'src\\App.vue',
    'src//App.vue',
    'src/%2e%2e/App.vue',
    'src/NUL.vue',
    'src/trailing. /App.vue'
  ])('rejects %s', (wirePath) => {
    expect(isWireRelativePath(wirePath)).toBe(false);
  });

  it('accepts POSIX relative paths with spaces and Chinese names', () => {
    expect(isWireRelativePath('src/页面组件/My Card.vue')).toBe(true);
  });
});
