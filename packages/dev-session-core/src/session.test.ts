import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSessionDescriptor } from '@web-source-inspector/protocol';
import {
  createBridgeToken,
  createBrowserToken,
  createSessionHmacKey,
  createSessionId,
  isLoopbackAddress,
  removeSessionDescriptor,
  writeSessionDescriptor,
  type SessionDescriptor
} from './session';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function descriptor(protocolVersion: '1.1' | '2.0' = '1.1'): SessionDescriptor {
  return {
    schemaVersion: 1,
    protocolVersion,
    sessionId: 'session_descriptor_1234',
    pid: process.pid,
    port: 45678,
    bridgePath: '/wsi/session-descriptor',
    token: 'token_descriptor_1234567890abcdefghijklmnop',
    createdAt: Date.now(),
    heartbeatAt: Date.now(),
    projectName: 'fixture',
    canonicalRoots: [
      {
        rootKey: 'root_descriptor_1234',
        canonicalPath: process.cwd(),
        displayName: 'fixture'
      }
    ],
    devOrigins: ['http://127.0.0.1:5173'],
    capabilities: ['vue']
  };
}

describe('session helpers', () => {
  it('为三类控制能力生成独立的 256-bit 凭据', () => {
    const hmacKey = createSessionHmacKey();
    const browserToken = createBrowserToken();
    const bridgeToken = createBridgeToken();

    expect(hmacKey).toHaveLength(32);
    expect(Buffer.from(browserToken, 'base64url')).toHaveLength(32);
    expect(Buffer.from(bridgeToken, 'base64url')).toHaveLength(32);
    expect(browserToken).not.toBe(bridgeToken);
  });

  it('生成协议可接受且带命名空间的 session ID', () => {
    const sessionId = createSessionId();

    expect(sessionId).toMatch(/^session_[A-Za-z0-9_-]+$/);
  });

  it('只接受 loopback 地址', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.42')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('原子写入兼容 minor，并可由共享协议解析和清理', async () => {
    const sessionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-session-'));
    temporaryDirectories.push(sessionDirectory);
    const descriptorPath = await writeSessionDescriptor(
      sessionDirectory,
      descriptor('1.1')
    );
    const serialized = await fs.readFile(descriptorPath, 'utf8');

    expect(parseSessionDescriptor(serialized)).toMatchObject({ ok: true });
    expect((await fs.readdir(sessionDirectory)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    await removeSessionDescriptor(sessionDirectory, descriptorPath);
    await expect(fs.stat(descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('写入前拒绝不兼容 major', async () => {
    const sessionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-session-'));
    temporaryDirectories.push(sessionDirectory);

    await expect(
      writeSessionDescriptor(sessionDirectory, descriptor('2.0'))
    ).rejects.toThrow('PROTOCOL_MISMATCH');
    expect(await fs.readdir(sessionDirectory)).toEqual([]);
  });

  it('writeFile 部分写入后抛错时清理本次临时文件', async () => {
    const sessionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-session-'));
    temporaryDirectories.push(sessionDirectory);
    const originalWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      await originalWriteFile(file, data, options);
      throw new Error('WRITE_FAILED_AFTER_CREATE');
    });

    await expect(
      writeSessionDescriptor(sessionDirectory, descriptor('1.1'))
    ).rejects.toThrow('WRITE_FAILED_AFTER_CREATE');
    expect(await fs.readdir(sessionDirectory)).toEqual([]);
  });
});
