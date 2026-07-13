import { describe, expect, it } from 'vitest';

import { parseIncomingBridgeMessage, parseOpenSourcePayload } from './bridgeProtocol';
import { createSourceDigest } from './sourceLocation';

function openPayload(): Record<string, unknown> {
  return {
    openRequestId: 'open-1',
    rootKey: 'root',
    relativePath: 'src/App.vue',
    range: {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 5,
      startOffset: 0,
      endOffset: 4,
    },
    sourceDigest: createSourceDigest('<div>'),
    contextBefore: null,
    contextAfter: '</div>',
    accuracy: 'exact',
    candidateKind: 'element',
    tagName: 'div',
    componentName: null,
    pageClientId: 'page-1',
    page: {
      origin: 'http://localhost:5173',
      pathname: '/examples/basic',
      title: 'Basic fixture',
    },
    candidates: [
      {
        candidateKind: 'component',
        label: 'App component',
        rootKey: 'root',
        relativePath: 'src/App.vue',
        range: {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 5,
          startOffset: 0,
          endOffset: 4,
        },
        sourceDigest: createSourceDigest('<div>'),
        contextBefore: null,
        contextAfter: '</div>',
        accuracy: 'exact',
      },
    ],
  };
}

describe('bridge protocol input validation', () => {
  it('accepts a valid envelope and preserves multiline transform contexts', () => {
    const payload = openPayload();
    payload.contextBefore = '<template>\r\n\t<section>\n    ';
    payload.contextAfter = '\r\n\t</section>\n</template>';
    const candidate = (payload.candidates as Record<string, unknown>[])[0];
    if (!candidate) {
      throw new Error('TEST_CANDIDATE_MISSING');
    }
    candidate.contextBefore = '<template>\n\t';
    candidate.contextAfter = '\r\n</template>';
    const envelope = JSON.stringify({
      protocolVersion: '1.1',
      messageId: 'message-1',
      type: 'server:open-source',
      sessionId: 'session-1',
      senderId: 'session-1',
      timestamp: Date.now(),
      payload,
    });
    expect(parseIncomingBridgeMessage(envelope, 'session-1').ok).toBe(true);
    expect(parseOpenSourcePayload(payload)).toMatchObject({
      relativePath: 'src/App.vue',
      contextBefore: '<template>\r\n\t<section>\n    ',
      contextAfter: '\r\n\t</section>\n</template>',
      candidates: [
        {
          contextBefore: '<template>\n\t',
          contextAfter: '\r\n</template>',
        },
      ],
    });
  });

  it('rejects a wrong session, timestamp drift, protocol major, malformed range, and excessive message', () => {
    const base = {
      protocolVersion: '1.0',
      messageId: 'message-1',
      type: 'heartbeat',
      sessionId: 'other-session',
      senderId: 'other-session',
      timestamp: Date.now(),
      payload: {},
    };
    expect(parseIncomingBridgeMessage(JSON.stringify(base), 'session-1')).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(
      parseIncomingBridgeMessage(
        JSON.stringify({ ...base, sessionId: 'session-1', senderId: 'tampered-sender' }),
        'session-1',
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(
      parseIncomingBridgeMessage(
        JSON.stringify({ ...base, sessionId: 'session-1', senderId: 'session-1', timestamp: Date.now() - 11 * 60_000 }),
        'session-1',
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(parseIncomingBridgeMessage(JSON.stringify({ ...base, protocolVersion: '2.0' }), 'other-session')).toMatchObject({
      ok: false,
      code: 'PROTOCOL_MISMATCH',
    });
    expect(parseOpenSourcePayload({ ...openPayload(), range: { startLine: 0 } })).toBeUndefined();
    expect(parseOpenSourcePayload({ ...openPayload(), contextBefore: undefined })).toBeUndefined();
    expect(parseOpenSourcePayload({ ...openPayload(), contextBefore: 'before\u0000after' })).toBeUndefined();
    expect(parseOpenSourcePayload({ ...openPayload(), contextAfter: 'before\u000bafter' })).toBeUndefined();
    expect(parseOpenSourcePayload({ ...openPayload(), page: { url: 'http://localhost:5173' } })).toBeUndefined();
    const candidate = (openPayload().candidates as unknown[])[0];
    expect(parseOpenSourcePayload({ ...openPayload(), candidates: Array.from({ length: 33 }, () => candidate) })).toBeUndefined();
    expect(parseIncomingBridgeMessage('x'.repeat(70_000), 'session-1')).toMatchObject({
      ok: false,
      code: 'MESSAGE_TOO_LARGE',
    });
  });
});
