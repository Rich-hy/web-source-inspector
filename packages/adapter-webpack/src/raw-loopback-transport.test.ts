import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createRawLoopbackBrowserTransport } from './raw-loopback-transport.js';

describe('RawLoopbackBrowserTransport dispose', () => {
  it('立即终止不响应 close 的客户端，并拒绝 dispose 后到达的 message', async () => {
    const receivedMessages: unknown[] = [];
    let transport: ReturnType<typeof createRawLoopbackBrowserTransport> | null = null;
    const server = http.createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!transport?.handleUpgrade(request, socket, head)) {
        socket.destroy();
      }
    });
    const port = await listenOnLoopback(server);
    const origin = `http://127.0.0.1:${port}`;
    transport = createRawLoopbackBrowserTransport({
      allowedOrigins: [origin],
      browserMessageHandler: {
        onMessage(payload) {
          receivedMessages.push(payload);
        },
      },
    });
    const socket = net.createConnection({ host: '127.0.0.1', port });

    try {
      await waitForConnect(socket);
      socket.write(createUpgradeRequest(
        port,
        origin,
        transport.descriptor.path,
        transport.descriptor.browserToken,
      ));
      const responseHead = await readUntil(socket, '\r\n\r\n', 1_000);
      expect(responseHead).toContain('101 Switching Protocols');

      transport.dispose();
      if (!socket.destroyed) {
        socket.write(createMaskedTextFrame(JSON.stringify({ event: 'late', payload: {} })));
      }
      await waitForClose(socket, 500);

      expect(receivedMessages).toEqual([]);
    } finally {
      socket.destroy();
      transport.dispose();
      await closeServer(server);
    }
  });

  it('dispose 后对自身随机 path 的新 upgrade 同步销毁 socket', () => {
    const transport = createRawLoopbackBrowserTransport({
      allowedOrigins: ['http://127.0.0.1:8080'],
    });
    const descriptor = transport.descriptor;
    transport.dispose();
    const destroy = vi.fn();
    const socket = { destroy } as unknown as Duplex;
    const request = {
      url: `${descriptor.path}?pageClientId=page-1`,
      headers: {
        origin: 'http://127.0.0.1:8080',
        host: '127.0.0.1:8080',
        'sec-websocket-protocol': `wsi-browser-v1, wsi-token.${descriptor.browserToken}`,
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;

    expect(() => transport.handleUpgrade(request, socket, Buffer.alloc(0))).not.toThrow();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

function createUpgradeRequest(
  port: number,
  origin: string,
  transportPath: string,
  browserToken: string,
): string {
  return [
    `GET ${transportPath}?pageClientId=page-1 HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    'Sec-WebSocket-Version: 13',
    `Origin: ${origin}`,
    `Sec-WebSocket-Protocol: wsi-browser-v1, wsi-token.${browserToken}`,
    '',
    '',
  ].join('\r\n');
}

function createMaskedTextFrame(value: string): Buffer {
  const payload = Buffer.from(value, 'utf8');
  if (payload.length >= 126) {
    throw new RangeError('测试 frame payload 必须小于 126 bytes');
  }
  const mask = randomBytes(4);
  const frame = Buffer.alloc(2 + mask.length + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = payload[index]! ^ mask[index % mask.length]!;
  }
  return frame;
}

function listenOnLoopback(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('测试 HTTP server 未取得端口'));
        return;
      }
      resolve(address.port);
    });
  });
}

function waitForConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}

function readUntil(socket: net.Socket, marker: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const timer = setTimeout(() => finish(new Error('读取 WebSocket handshake 超时')), timeoutMs);
    const onData = (chunk: Buffer): void => {
      value += chunk.toString('latin1');
      if (value.includes(marker)) {
        finish(null);
      }
    };
    const onClose = (): void => finish(new Error('WebSocket handshake 前连接关闭'));
    const onError = (error: Error): void => finish(error);
    const finish = (error: Error | null): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function waitForClose(socket: net.Socket, timeoutMs: number): Promise<void> {
  if (socket.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('close', onClose);
      reject(new Error('dispose 未及时终止底层 socket'));
    }, timeoutMs);
    const onClose = (): void => {
      clearTimeout(timer);
      resolve();
    };
    socket.once('close', onClose);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
