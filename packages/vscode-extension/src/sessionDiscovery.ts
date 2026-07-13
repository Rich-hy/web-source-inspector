import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PROTOCOL_LIMITS,
  validateSessionDescriptor as validateProtocolSessionDescriptor,
  type ProtocolValidationIssue,
} from '@web-source-inspector/protocol';

import type { SessionDescriptor } from './types';

const MAX_SESSION_FILE_BYTES = PROTOCOL_LIMITS.sessionDescriptorBytes;
const DEFAULT_SESSION_TTL_MS = 30_000;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export interface SessionDirectoryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  temporaryDirectory?: string;
  userId?: number;
}

export interface DiscoveredSession {
  descriptor: SessionDescriptor;
  descriptorPath: string;
}

export interface DiscoveryOptions extends SessionDirectoryOptions {
  now?: number;
  ttlMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

function isAbsoluteDirectory(directory: string | undefined, platform: NodeJS.Platform): directory is string {
  if (!directory) {
    return false;
  }
  return platform === 'win32' ? path.win32.isAbsolute(directory) : path.posix.isAbsolute(directory);
}

export function getSessionDirectories(options: SessionDirectoryOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
  const directories: string[] = [];

  if (platform === 'win32' && isAbsoluteDirectory(env.LOCALAPPDATA, platform)) {
    directories.push(path.win32.join(env.LOCALAPPDATA, 'web-source-inspector', 'sessions'));
  } else if (platform === 'darwin' && isAbsoluteDirectory(homeDirectory, platform)) {
    directories.push(path.posix.join(homeDirectory, 'Library', 'Caches', 'web-source-inspector', 'sessions'));
  } else if (platform !== 'win32') {
    if (isAbsoluteDirectory(env.XDG_RUNTIME_DIR, platform)) {
      directories.push(path.posix.join(env.XDG_RUNTIME_DIR, 'web-source-inspector', 'sessions'));
    } else if (isAbsoluteDirectory(env.XDG_CACHE_HOME, platform)) {
      directories.push(path.posix.join(env.XDG_CACHE_HOME, 'web-source-inspector', 'sessions'));
    } else if (isAbsoluteDirectory(homeDirectory, platform)) {
      directories.push(path.posix.join(homeDirectory, '.cache', 'web-source-inspector', 'sessions'));
    }
  }

  if (isAbsoluteDirectory(temporaryDirectory, platform)) {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const userSuffix = options.userId === undefined ? 'user' : String(options.userId);
    directories.push(pathApi.join(temporaryDirectory, `web-source-inspector-${userSuffix}`, 'sessions'));
    // 兼容首版服务端 fallback；Unix 读取时仍校验目录归属和权限。
    directories.push(pathApi.join(temporaryDirectory, 'web-source-inspector', 'sessions'));
  }

  return [...new Set(directories)];
}

export type SessionParseResult =
  | { ok: true; descriptor: SessionDescriptor }
  | { ok: false; reason: string };

function sessionValidationReason(error: ProtocolValidationIssue): string {
  if (error.code === 'PROTOCOL_MISMATCH' || error.path === '$.schemaVersion') {
    return 'PROTOCOL_MISMATCH';
  }
  if (error.path === '$') {
    return 'SESSION_NOT_OBJECT';
  }
  if (error.path === '$.sessionId') {
    return 'INVALID_SESSION_ID';
  }
  if (error.path === '$.pid') {
    return 'INVALID_PID';
  }
  if (error.path === '$.port') {
    return 'INVALID_PORT';
  }
  if (error.path === '$.bridgePath') {
    return 'INVALID_BRIDGE_PATH';
  }
  if (error.path === '$.token') {
    return 'INVALID_TOKEN';
  }
  if (error.path === '$.createdAt' || error.path === '$.heartbeatAt') {
    return 'INVALID_TIMESTAMPS';
  }
  if (error.path === '$.projectName') {
    return 'INVALID_PROJECT_NAME';
  }
  if (error.path.startsWith('$.canonicalRoots')) {
    return error.message.includes('不能重复') ? 'DUPLICATE_ROOT_KEY' : 'INVALID_ROOT';
  }
  if (error.path.startsWith('$.devOrigins')) {
    return 'INVALID_ORIGINS';
  }
  if (error.path.startsWith('$.capabilities')) {
    return 'INVALID_CAPABILITIES';
  }
  return 'INVALID_SESSION_DESCRIPTOR';
}

/** Session 文件属于安全边界，未知或越界字段一律拒绝而不是猜测兼容。 */
export function parseSessionDescriptor(value: unknown): SessionParseResult {
  const validated = validateProtocolSessionDescriptor(value);
  if (!validated.ok) {
    return { ok: false, reason: sessionValidationReason(validated.error) };
  }
  const descriptor = validated.value;
  if (!SAFE_SESSION_ID.test(descriptor.sessionId)) {
    return { ok: false, reason: 'INVALID_SESSION_ID' };
  }
  if (CONTROL_CHARACTER.test(descriptor.projectName)) {
    return { ok: false, reason: 'INVALID_PROJECT_NAME' };
  }
  if (
    descriptor.canonicalRoots.some(
      (root) =>
        !path.isAbsolute(root.canonicalPath) ||
        CONTROL_CHARACTER.test(root.canonicalPath) ||
        CONTROL_CHARACTER.test(root.displayName),
    )
  ) {
    return { ok: false, reason: 'INVALID_ROOT' };
  }

  return { ok: true, descriptor };
}

export function isSessionFresh(descriptor: SessionDescriptor, now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS): boolean {
  return descriptor.heartbeatAt <= now + 5_000 && now - descriptor.heartbeatAt <= ttlMs;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readSessionFile(
  descriptorPath: string,
  now: number,
  ttlMs: number,
  processAlive: (pid: number) => boolean,
): Promise<DiscoveredSession | undefined> {
  try {
    const fileStat = await fs.lstat(descriptorPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_SESSION_FILE_BYTES) {
      return undefined;
    }
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      (fileStat.uid !== process.getuid() || (fileStat.mode & 0o077) !== 0)
    ) {
      return undefined;
    }
    const source = await fs.readFile(descriptorPath, 'utf8');
    const parsedJson: unknown = JSON.parse(source);
    const parsed = parseSessionDescriptor(parsedJson);
    if (!parsed.ok || !isSessionFresh(parsed.descriptor, now, ttlMs) || !processAlive(parsed.descriptor.pid)) {
      return undefined;
    }
    return { descriptor: parsed.descriptor, descriptorPath };
  } catch {
    return undefined;
  }
}

export async function discoverSessions(options: DiscoveryOptions = {}): Promise<DiscoveredSession[]> {
  const directories = getSessionDirectories(options);
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const processAlive = options.isProcessAlive ?? isProcessAlive;
  const discovered: DiscoveredSession[] = [];

  for (const directory of directories) {
    let entries;
    try {
      const directoryStat = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        continue;
      }
      if (
        process.platform !== 'win32' &&
        typeof process.getuid === 'function' &&
        (directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o077) !== 0)
      ) {
        continue;
      }
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    const candidates = entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
      .slice(0, 256);
    const sessions = await Promise.all(
      candidates.map((entry) => readSessionFile(path.join(directory, entry.name), now, ttlMs, processAlive)),
    );
    discovered.push(...sessions.filter((session): session is DiscoveredSession => session !== undefined));
  }

  const bySessionId = new Map<string, DiscoveredSession>();
  for (const session of discovered) {
    const current = bySessionId.get(session.descriptor.sessionId);
    if (!current || current.descriptor.heartbeatAt < session.descriptor.heartbeatAt) {
      bySessionId.set(session.descriptor.sessionId, session);
    }
  }
  return [...bySessionId.values()].sort((left, right) => right.descriptor.heartbeatAt - left.descriptor.heartbeatAt);
}
