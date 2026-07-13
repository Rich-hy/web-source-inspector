import { describe, expect, it } from 'vitest';

import { formatDiagnostics, redactDiagnosticText, shortSessionId } from './diagnostics';

describe('diagnostic redaction', () => {
  it('redacts bearer tokens, token fields, home paths, and URL queries', () => {
    const source =
      'Authorization: Bearer abc.def token=top-secret C:\\Users\\dev\\repo http://localhost:5173/page?password=value';
    const redacted = redactDiagnosticText(source, 'C:\\Users\\dev');
    expect(redacted).not.toContain('abc.def');
    expect(redacted).not.toContain('top-secret');
    expect(redacted).not.toContain('C:\\Users\\dev');
    expect(redacted).not.toContain('password=value');
  });

  it('formats only a short session id and never accepts a path field', () => {
    const output = formatDiagnostics({
      extensionVersion: '0.1.0',
      ideKind: 'vscode',
      trusted: true,
      remote: false,
      connectionState: 'active',
      sessionId: 'session-12345678',
      projectName: 'fixture',
      protocolVersion: '1.0',
      matchingRootCount: 1,
      browserTabCount: 1,
    });
    expect(output).toContain('session: session-');
    expect(output).not.toContain('session-12345678');
  });

  it('保留会话命名空间并用随机后缀区分真实 session ID', () => {
    const firstSession = shortSessionId('session_abcdefgh1234567890');
    const secondSession = shortSessionId('session_qrstuvwx1234567890');

    expect(firstSession).toBe('session_abcdefgh');
    expect(secondSession).toBe('session_qrstuvwx');
    expect(firstSession).not.toBe(secondSession);
    expect(shortSessionId('webpack_abcdefgh1234567890')).toBe('webpack_abcdefgh');
  });
});
