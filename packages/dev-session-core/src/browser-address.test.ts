import { describe, expect, it } from 'vitest';

import {
  createBrowserAddressPolicy,
  createBrowserAddressSnapshot,
  isBrowserOriginAuthorized,
  normalizeBrowserAddress,
} from './browser-address.js';

describe('Browser 地址策略', () => {
  it('规范化 IPv4、IPv6、mapped IPv6 和 zone id', () => {
    expect(normalizeBrowserAddress('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeBrowserAddress('127.0.0.42')).toBe('127.0.0.42');
    expect(normalizeBrowserAddress('192.168.8.155')).toBe('192.168.8.155');
    expect(normalizeBrowserAddress('::1')).toBe('::1');
    expect(normalizeBrowserAddress('2001:0db8:0000:0000:0000:ff00:0042:8329'))
      .toBe('2001:db8::ff00:42:8329');
    expect(normalizeBrowserAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeBrowserAddress('::ffff:192.168.8.155')).toBe('192.168.8.155');
    expect(normalizeBrowserAddress('fe80::10%12')).toBe('fe80::10');
  });

  it('拒绝空白、非法、未指定和多播地址', () => {
    expect(normalizeBrowserAddress(undefined)).toBeNull();
    expect(normalizeBrowserAddress('')).toBeNull();
    expect(normalizeBrowserAddress(' 127.0.0.1')).toBeNull();
    expect(normalizeBrowserAddress('not-an-address')).toBeNull();
    expect(normalizeBrowserAddress('127.0.0.1%12')).toBeNull();
    expect(normalizeBrowserAddress('0.0.0.0')).toBeNull();
    expect(normalizeBrowserAddress('::')).toBeNull();
    expect(normalizeBrowserAddress('224.0.0.1')).toBeNull();
    expect(normalizeBrowserAddress('ff02::1')).toBeNull();
  });

  it('只从一次接口读取创建去重、排序且冻结的快照', () => {
    let readCount = 0;
    const snapshot = createBrowserAddressSnapshot({
      networkInterfaces: () => {
        readCount += 1;
        return {
          ethernet: [
            { address: '192.168.8.155' },
            { address: '::ffff:192.168.8.155' },
            { address: 'fe80::10%12' },
            { address: '224.0.0.1' },
          ],
          vpn: [{ address: '10.23.0.7' }],
        };
      },
    });

    expect(readCount).toBe(1);
    expect(snapshot.addresses).toEqual(['10.23.0.7', '192.168.8.155', 'fe80::10']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.addresses)).toBe(true);
  });

  it('loopback 仅接受回环地址，同机模式仅接受快照中的精确地址', () => {
    const snapshot = createBrowserAddressSnapshot({
      addresses: ['192.168.8.155', '10.23.0.7'],
    });
    const loopbackPolicy = createBrowserAddressPolicy({
      mode: 'loopback',
      snapshot,
    });
    const sameMachinePolicy = createBrowserAddressPolicy({
      mode: 'same-machine',
      snapshot,
    });

    expect(loopbackPolicy.authorize('127.0.0.42')).toEqual({
      allowed: true,
      normalizedAddress: '127.0.0.42',
      loopback: true,
    });
    expect(loopbackPolicy.authorize('192.168.8.155')).toEqual({ allowed: false });
    expect(sameMachinePolicy.authorize('::ffff:192.168.8.155')).toEqual({
      allowed: true,
      normalizedAddress: '192.168.8.155',
      loopback: false,
    });
    expect(sameMachinePolicy.authorize('10.23.0.7')).toEqual({
      allowed: true,
      normalizedAddress: '10.23.0.7',
      loopback: false,
    });
    expect(sameMachinePolicy.authorize('192.168.8.156')).toEqual({ allowed: false });
    expect(sameMachinePolicy.authorize('10.23.0.8')).toEqual({ allowed: false });
  });

  it('回环保留 localhost Origin 特例，同机地址要求字面量 IP 精确匹配', () => {
    expect(isBrowserOriginAuthorized({
      mode: 'loopback',
      normalizedRemoteAddress: '127.0.0.1',
      remoteAddressLoopback: true,
      origin: 'http://localhost:5173',
      allowedOrigins: ['http://localhost:5173'],
    })).toBe(true);

    const options = {
      mode: 'same-machine' as const,
      normalizedRemoteAddress: '192.168.8.155',
      remoteAddressLoopback: false,
      allowedOrigins: ['http://192.168.8.155:5173'],
    };
    expect(isBrowserOriginAuthorized({
      ...options,
      origin: 'http://192.168.8.155:5173',
    })).toBe(true);
    expect(isBrowserOriginAuthorized({
      ...options,
      origin: 'http://localhost:5173',
    })).toBe(false);
    expect(isBrowserOriginAuthorized({
      ...options,
      origin: 'http://192.168.8.156:5173',
    })).toBe(false);
    expect(isBrowserOriginAuthorized({
      ...options,
      origin: 'http://192.168.8.155:5174',
    })).toBe(false);
    expect(isBrowserOriginAuthorized({
      ...options,
      origin: 'https://192.168.8.155:5173',
    })).toBe(false);
    expect(isBrowserOriginAuthorized({
      ...options,
      origin: 'http://192.168.8.155:5173/path',
    })).toBe(false);
  });
});
