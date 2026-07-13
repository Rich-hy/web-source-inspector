import http from 'node:http';

import { createRawLoopbackBrowserTransport } from './raw-loopback-transport.js';
import type {
  RawLoopbackBrowserTransportOptions,
  RawWatchServer,
} from './types.js';

export async function startRawLoopbackWatchServer(
  options: RawLoopbackBrowserTransportOptions,
): Promise<RawWatchServer> {
  const transport = createRawLoopbackBrowserTransport(options);
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.end('NOT_FOUND');
  });
  server.on('upgrade', (request, socket, head) => {
    if (!transport.handleUpgrade(request, socket, head)) {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    transport.dispose();
    server.close();
    throw new Error('RAW_LOOPBACK_ADDRESS_UNAVAILABLE');
  }
  server.unref?.();
  let disposed = false;
  return {
    port: address.port,
    transport,
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      transport.dispose();
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
