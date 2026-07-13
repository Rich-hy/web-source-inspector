import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, type RawData } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_SUBPROTOCOL,
  type BridgeMessageType,
  type BridgePayloadMap,
  type ProtocolEnvelope,
  type ProtocolVersion
} from '@web-source-inspector/protocol';
import { createLoopbackBridge } from './bridge';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function envelope<TType extends BridgeMessageType>(
  type: TType,
  senderId: string,
  sessionId: string,
  payload: BridgePayloadMap[TType],
  protocolVersion: ProtocolVersion = '1.0'
): ProtocolEnvelope<TType, BridgePayloadMap[TType]> {
  return {
    protocolVersion,
    messageId: randomUUID(),
    type,
    sessionId,
    senderId,
    timestamp: Date.now(),
    payload
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function waitForMessage(socket: WebSocket, type: string): Promise<ProtocolEnvelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 4_000);
    const listener = (data: RawData): void => {
      const message = JSON.parse(data.toString()) as ProtocolEnvelope;
      if (message.type === type) {
        clearTimeout(timer);
        socket.off('message', listener);
        resolve(message);
      }
    };
    socket.on('message', listener);
  });
}

describe('loopback bridge', () => {
  it('完成认证、单 IDE 路由和打开回执', async () => {
    const sessionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-bridge-'));
    temporaryDirectories.push(sessionDirectory);
    const onOpenResult = vi.fn();
    const onConnectionChange = vi.fn();
    const sessionId = 'session_bridge_1234';
    const token = 'token_1234567890abcdefghijklmnopqrstuvwxyz';
    const root = { rootKey: 'root_12345678', canonicalPath: process.cwd(), displayName: 'fixture' };
    const bridge = await createLoopbackBridge({
      session: {
        schemaVersion: 1,
        protocolVersion: '1.0',
        sessionId,
        pid: process.pid,
        bridgePath: '/wsi/test-bridge-path',
        token,
        createdAt: Date.now(),
        projectName: 'fixture',
        canonicalRoots: [root],
        devOrigins: ['http://127.0.0.1:5173'],
        capabilities: ['vue']
      },
      sessionDirectory,
      getBrowserTabs: () => [],
      onOpenResult,
      onConnectionChange,
      onSetBrowserMode: vi.fn()
    });

    const socket = new WebSocket(
      `ws://127.0.0.1:${bridge.descriptor.port}${bridge.descriptor.bridgePath}`,
      BRIDGE_SUBPROTOCOL,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    await waitForOpen(socket);
    const helloAck = waitForMessage(socket, 'server:hello-ack');
    socket.send(JSON.stringify(envelope('ide:hello', 'ide_client_1234', sessionId, {
      ideClientId: 'ide_client_1234',
      ideName: 'VS Code',
      extensionVersion: '0.1.0',
      workspaceRoots: [{ rootKey: root.rootKey, canonicalPath: root.canonicalPath }],
      capabilities: ['open-source'],
      focused: true
    }, '1.1')));
    await helloAck;

    const senderError = waitForMessage(socket, 'error');
    socket.send(JSON.stringify(envelope(
      'heartbeat',
      'ide_client_other',
      sessionId,
      {},
      '1.1'
    )));
    await expect(senderError).resolves.toMatchObject({
      payload: { code: 'AUTH_FAILED' }
    });

    const openMessagePromise = waitForMessage(socket, 'server:open-source');
    const accepted = bridge.requestOpenSource({
      pageClientId: 'page_client_1234',
      rootKey: root.rootKey,
      relativePath: 'src/App.vue',
      range: {
        startLine: 2,
        startColumn: 3,
        endLine: 2,
        endColumn: 10,
        startOffset: 12,
        endOffset: 19
      },
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      contextBefore: '<template>',
      contextAfter: '</template>',
      accuracy: 'exact',
      candidateKind: 'element',
      tagName: 'button',
      componentName: 'App',
      candidates: [],
      page: { origin: 'http://127.0.0.1:5173', pathname: '/', title: 'Fixture' }
    });
    expect(accepted.accepted).toBe(true);
    expect(bridge.requestOpenSource({
      pageClientId: 'page_client_1234',
      rootKey: root.rootKey,
      relativePath: 'src/Other.vue',
      range: {
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 2,
        startOffset: 0,
        endOffset: 1
      },
      sourceDigest: `sha256:${'b'.repeat(64)}`,
      contextBefore: null,
      contextAfter: null,
      accuracy: 'exact',
      candidateKind: 'element',
      tagName: 'div',
      componentName: null,
      candidates: [],
      page: { origin: 'http://127.0.0.1:5173', pathname: '/', title: 'Fixture' }
    })).toEqual({ accepted: false, code: 'RATE_LIMITED' });
    const openMessage = await openMessagePromise;
    socket.send(JSON.stringify(envelope('ide:open-result', 'ide_client_1234', sessionId, {
      requestMessageId: openMessage.messageId,
      ok: true,
      relativePath: 'src/App.vue',
      line: 2,
      accuracy: 'exact'
    }, '1.1')));

    await vi.waitFor(() => expect(onOpenResult).toHaveBeenCalledOnce());
    expect(onConnectionChange).toHaveBeenCalledWith(expect.objectContaining({ connected: true, ideName: 'VS Code' }));
    socket.close();
    await bridge.dispose();
  });

  it('拒绝同一 WebSocket 重复 hello', async () => {
    const sessionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-bridge-'));
    temporaryDirectories.push(sessionDirectory);
    const sessionId = 'session_bridge_repeat';
    const token = 'token_repeat_1234567890abcdefghijklmnop';
    const root = { rootKey: 'root_repeat_1234', canonicalPath: process.cwd(), displayName: 'fixture' };
    const bridge = await createLoopbackBridge({
      session: {
        schemaVersion: 1,
        protocolVersion: '1.0',
        sessionId,
        pid: process.pid,
        bridgePath: '/wsi/repeat-hello',
        token,
        createdAt: Date.now(),
        projectName: 'fixture',
        canonicalRoots: [root],
        devOrigins: [],
        capabilities: ['vue']
      },
      sessionDirectory,
      getBrowserTabs: () => [],
      onOpenResult: vi.fn(),
      onConnectionChange: vi.fn(),
      onSetBrowserMode: vi.fn()
    });
    const socket = new WebSocket(
      `ws://127.0.0.1:${bridge.descriptor.port}${bridge.descriptor.bridgePath}`,
      BRIDGE_SUBPROTOCOL,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    await waitForOpen(socket);
    const sendHello = (ideClientId: string): void => socket.send(JSON.stringify(envelope(
      'ide:hello',
      ideClientId,
      sessionId,
      {
        ideClientId,
        ideName: 'VS Code',
        extensionVersion: '0.1.0',
        workspaceRoots: [{ rootKey: root.rootKey, canonicalPath: root.canonicalPath }],
        capabilities: [],
        focused: true
      }
    )));
    const ack = waitForMessage(socket, 'server:hello-ack');
    sendHello('ide_client_first');
    await ack;
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    sendHello('ide_client_second');
    await expect(closed).resolves.toBe(1008);
    await bridge.dispose();
  });

  it('拒绝不兼容 major，并返回明确协议错误', async () => {
    const sessionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-bridge-'));
    temporaryDirectories.push(sessionDirectory);
    const sessionId = 'session_bridge_major';
    const token = 'token_major_1234567890abcdefghijklmnop';
    const root = { rootKey: 'root_major_1234', canonicalPath: process.cwd(), displayName: 'fixture' };
    const bridge = await createLoopbackBridge({
      session: {
        schemaVersion: 1,
        protocolVersion: '1.0',
        sessionId,
        pid: process.pid,
        bridgePath: '/wsi/major-version',
        token,
        createdAt: Date.now(),
        projectName: 'fixture',
        canonicalRoots: [root],
        devOrigins: [],
        capabilities: ['vue']
      },
      sessionDirectory,
      getBrowserTabs: () => [],
      onOpenResult: vi.fn(),
      onConnectionChange: vi.fn(),
      onSetBrowserMode: vi.fn()
    });
    const socket = new WebSocket(
      `ws://127.0.0.1:${bridge.descriptor.port}${bridge.descriptor.bridgePath}`,
      BRIDGE_SUBPROTOCOL,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    await waitForOpen(socket);
    const errorMessage = waitForMessage(socket, 'error');
    socket.send(JSON.stringify(envelope('ide:hello', 'ide_client_major', sessionId, {
      ideClientId: 'ide_client_major',
      ideName: 'VS Code',
      extensionVersion: '0.1.0',
      workspaceRoots: [{ rootKey: root.rootKey, canonicalPath: root.canonicalPath }],
      capabilities: [],
      focused: true
    }, '2.0')));

    await expect(errorMessage).resolves.toMatchObject({
      payload: { code: 'PROTOCOL_MISMATCH' }
    });
    socket.close();
    await bridge.dispose();
  });

  it('session 描述文件写入失败时回滚监听服务', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-bridge-fail-'));
    temporaryDirectories.push(temporaryRoot);
    const blockedDirectory = path.join(temporaryRoot, 'not-a-directory');
    await fs.writeFile(blockedDirectory, 'blocked', 'utf8');

    await expect(createLoopbackBridge({
      session: {
        schemaVersion: 1,
        protocolVersion: '1.0',
        sessionId: 'session_write_failure',
        pid: process.pid,
        bridgePath: '/wsi/write-failure',
        token: 'token_write_failure_1234567890abcdef',
        createdAt: Date.now(),
        projectName: 'fixture',
        canonicalRoots: [{ rootKey: 'root_write_fail', canonicalPath: process.cwd(), displayName: 'fixture' }],
        devOrigins: [],
        capabilities: []
      },
      sessionDirectory: blockedDirectory,
      getBrowserTabs: () => [],
      onOpenResult: vi.fn(),
      onConnectionChange: vi.fn(),
      onSetBrowserMode: vi.fn()
    })).rejects.toBeInstanceOf(Error);
  });

  it('dispose 等待进行中的 heartbeat 写入后再删除 descriptor', async () => {
    const sessionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-bridge-race-'));
    temporaryDirectories.push(sessionDirectory);
    const bridge = await createLoopbackBridge({
      session: {
        schemaVersion: 1,
        protocolVersion: '1.0',
        sessionId: 'session_dispose_race',
        pid: process.pid,
        bridgePath: '/wsi/dispose-race',
        token: 'token_dispose_race_1234567890abcdef',
        createdAt: Date.now(),
        projectName: 'fixture',
        canonicalRoots: [
          {
            rootKey: 'root_dispose_race',
            canonicalPath: process.cwd(),
            displayName: 'fixture'
          }
        ],
        devOrigins: [],
        capabilities: []
      },
      sessionDirectory,
      getBrowserTabs: () => [],
      onOpenResult: vi.fn(),
      onConnectionChange: vi.fn(),
      onSetBrowserMode: vi.fn()
    });
    const originalRename = fs.rename.bind(fs);
    let releaseRename: (() => void) | undefined;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    let notifyRenameStarted: (() => void) | undefined;
    const renameStarted = new Promise<void>((resolve) => {
      notifyRenameStarted = resolve;
    });
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      notifyRenameStarted?.();
      await renameGate;
      await originalRename(oldPath, newPath);
    });

    await renameStarted;
    let disposed = false;
    const disposePromise = bridge.dispose().then(() => {
      disposed = true;
    });
    await delay(50);
    const disposedBeforeWriteFinished = disposed;
    releaseRename?.();
    await disposePromise;
    await delay(50);

    expect(disposedBeforeWriteFinished).toBe(false);
    await expect(fs.stat(bridge.descriptorPath)).rejects.toMatchObject({
      code: 'ENOENT'
    });
  }, 10_000);
});
import { randomUUID } from 'node:crypto';
