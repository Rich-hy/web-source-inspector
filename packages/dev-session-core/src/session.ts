import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSessionDescriptor,
  validateSessionDescriptor,
  type SessionDescriptor,
  type SessionRootDescriptor
} from '@web-source-inspector/protocol';

export { BRIDGE_SUBPROTOCOL, SESSION_SCHEMA_VERSION } from '@web-source-inspector/protocol';
export type { SessionDescriptor } from '@web-source-inspector/protocol';
export type SessionRoot = SessionRootDescriptor;

export function createSessionId(): string {
  // 固定字母前缀，避免 Base64URL 随机首字符违反协议的 safe ID 规则。
  return `session_${randomBytes(16).toString('base64url')}`;
}

// 三类凭据独立生成，禁止从任一 token 派生其它控制能力。
export function createSessionHmacKey(): Buffer {
  return randomBytes(32);
}

export function createBrowserToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createBridgeToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createBridgePath(): string {
  return `/wsi/${randomBytes(18).toString('base64url')}`;
}

export function getSessionDirectory(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'web-source-inspector', 'sessions');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'web-source-inspector', 'sessions');
  }
  if (process.platform === 'linux' && process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'web-source-inspector', 'sessions');
  }
  return path.join(os.tmpdir(), 'web-source-inspector', 'sessions');
}

function assertDescriptorPath(sessionDirectory: string, descriptorPath: string): void {
  const relative = path.relative(path.resolve(sessionDirectory), path.resolve(descriptorPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(relative) !== '.json') {
    throw new Error('INVALID_SESSION_DESCRIPTOR_PATH');
  }
}

export async function writeSessionDescriptor(
  sessionDirectory: string,
  descriptor: SessionDescriptor
): Promise<string> {
  const validation = validateSessionDescriptor(descriptor);
  if (!validation.ok) {
    throw new Error(`${validation.error.code}:${validation.error.path}`);
  }
  const serialized = `${JSON.stringify(validation.value, null, 2)}\n`;
  const serializedValidation = parseSessionDescriptor(serialized);
  if (!serializedValidation.ok) {
    throw new Error(
      `${serializedValidation.error.code}:${serializedValidation.error.path}`
    );
  }

  await fs.mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const descriptorPath = path.join(sessionDirectory, `${descriptor.sessionId}.json`);
  assertDescriptorPath(sessionDirectory, descriptorPath);
  const temporaryPath = path.join(
    sessionDirectory,
    `.${descriptor.sessionId}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
  let committed = false;
  try {
    await fs.writeFile(temporaryPath, serialized, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    await fs.rename(temporaryPath, descriptorPath);
    committed = true;
  } finally {
    if (!committed) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
  return descriptorPath;
}

export async function removeSessionDescriptor(sessionDirectory: string, descriptorPath: string): Promise<void> {
  assertDescriptorPath(sessionDirectory, descriptorPath);
  await fs.rm(descriptorPath, { force: true });
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  const normalized = address.toLowerCase().split('%', 1)[0] || '';
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
    || normalized.startsWith('127.');
}
