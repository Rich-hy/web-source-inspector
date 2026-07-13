export interface DiagnosticsSnapshot {
  extensionVersion: string;
  ideKind: 'vscode' | 'cursor';
  trusted: boolean;
  remote: boolean;
  connectionState: string;
  sessionId?: string;
  projectName?: string;
  protocolVersion?: string;
  matchingRootCount: number;
  browserTabCount: number;
  lastCode?: string;
}

export function shortSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    return '-';
  }
  const namespacePrefix = sessionId.startsWith('session_')
    ? 'session_'
    : sessionId.startsWith('webpack_')
      ? 'webpack_'
      : undefined;
  if (namespacePrefix) {
    return `${namespacePrefix}${sessionId.slice(namespacePrefix.length, namespacePrefix.length + 8)}`;
  }
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 用于输出通道和复制内容，token、Authorization、用户目录和 URL 查询始终脱敏。 */
export function redactDiagnosticText(text: string, homeDirectory?: string): string {
  let redacted = text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,"']+/giu, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/giu, '$1[REDACTED]')
    .replace(/(["']?(?:token|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu, '$1[REDACTED]')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/giu, '$1?[REDACTED]');
  if (homeDirectory) {
    redacted = redacted.replace(new RegExp(escapeRegularExpression(homeDirectory), 'giu'), '[USER_HOME]');
  }
  return redacted;
}

export function formatDiagnostics(snapshot: DiagnosticsSnapshot): string {
  return [
    'Web Source Inspector diagnostics',
    `extensionVersion: ${snapshot.extensionVersion}`,
    `ideKind: ${snapshot.ideKind}`,
    `workspaceTrusted: ${snapshot.trusted}`,
    `remoteEnvironment: ${snapshot.remote}`,
    `connectionState: ${snapshot.connectionState}`,
    `session: ${shortSessionId(snapshot.sessionId)}`,
    `project: ${snapshot.projectName ?? '-'}`,
    `protocolVersion: ${snapshot.protocolVersion ?? '-'}`,
    `matchingRoots: ${snapshot.matchingRootCount}`,
    `browserTabs: ${snapshot.browserTabCount}`,
    `lastCode: ${snapshot.lastCode ?? '-'}`,
    'Sensitive values and absolute paths are intentionally omitted.',
  ].join('\n');
}
