import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSessionDirectories, isSessionFresh, parseSessionDescriptor } from './sessionDiscovery';
import { PROTOCOL_VERSION, type SessionDescriptor } from './types';

function validSession(): SessionDescriptor {
  return {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    sessionId: 'session-12345678',
    pid: 1234,
    port: 51_234,
    bridgePath: '/bridge/session-12345678',
    token: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    createdAt: 1_000,
    heartbeatAt: 2_000,
    projectName: 'fixture',
    canonicalRoots: [{ rootKey: 'root', canonicalPath: path.resolve('fixture'), displayName: 'fixture' }],
    devOrigins: ['http://localhost:5173'],
    capabilities: ['open-source', 'browser-mode'],
  };
}

describe('getSessionDirectories', () => {
  it('uses LOCALAPPDATA on Windows with a controlled temp fallback', () => {
    expect(
      getSessionDirectories({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
        homeDirectory: 'C:\\Users\\dev',
        temporaryDirectory: 'C:\\Temp',
      }),
    ).toEqual([
      'C:\\Users\\dev\\AppData\\Local\\web-source-inspector\\sessions',
      'C:\\Temp\\web-source-inspector-user\\sessions',
      'C:\\Temp\\web-source-inspector\\sessions',
    ]);
  });

  it('uses XDG_RUNTIME_DIR on Linux', () => {
    expect(
      getSessionDirectories({
        platform: 'linux',
        env: { XDG_RUNTIME_DIR: '/run/user/1000' },
        homeDirectory: '/home/dev',
        temporaryDirectory: '/tmp',
        userId: 1000,
      }),
    ).toEqual([
      '/run/user/1000/web-source-inspector/sessions',
      '/tmp/web-source-inspector-1000/sessions',
      '/tmp/web-source-inspector/sessions',
    ]);
  });

  it('uses the user cache directory on macOS', () => {
    expect(
      getSessionDirectories({
        platform: 'darwin',
        env: {},
        homeDirectory: '/Users/dev',
        temporaryDirectory: '/tmp',
      }),
    ).toEqual([
      '/Users/dev/Library/Caches/web-source-inspector/sessions',
      '/tmp/web-source-inspector-user/sessions',
      '/tmp/web-source-inspector/sessions',
    ]);
  });
});

describe('parseSessionDescriptor', () => {
  it('accepts the fixed loopback bridge descriptor contract and a compatible minor version', () => {
    expect(parseSessionDescriptor(validSession())).toEqual({ ok: true, descriptor: validSession() });
    expect(parseSessionDescriptor({ ...validSession(), protocolVersion: '1.1' })).toMatchObject({
      ok: true,
      descriptor: { protocolVersion: '1.1' },
    });
    expect(parseSessionDescriptor({ ...validSession(), protocolVersion: '2.0' })).toMatchObject({
      ok: false,
      reason: 'PROTOCOL_MISMATCH',
    });
  });

  it('accepts descriptors without a subprotocol field and rejects duplicate root keys', () => {
    expect(parseSessionDescriptor(validSession())).toMatchObject({ ok: true });
    expect(
      parseSessionDescriptor({
        ...validSession(),
        canonicalRoots: [
          ...validSession().canonicalRoots,
          { rootKey: 'root', canonicalPath: 'D:\\project\\other', displayName: 'other' },
        ],
      }),
    ).toMatchObject({ ok: false, reason: 'DUPLICATE_ROOT_KEY' });
  });

  it('rejects stale and future heartbeat timestamps', () => {
    const descriptor = validSession();
    expect(isSessionFresh(descriptor, 32_001, 30_000)).toBe(false);
    expect(isSessionFresh(descriptor, -4_000, 30_000)).toBe(false);
  });
});
