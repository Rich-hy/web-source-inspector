import { describe, expect, it, vi } from 'vitest';

import { WebSourceInspectorWebpackPlugin } from './plugin.js';
import {
  createWebpackAdapterSession,
  disposeWebpackAdapterSession,
  getWebpackAdapterSession,
} from './registry.js';
import type { WebpackCompilerLike } from './types.js';

const REGISTRY_SYMBOL = Symbol.for('web-source-inspector.adapter-webpack.registry');

describe('Webpack adapter global registry', () => {
  it('compiler session ID 即使随机值以 Base64URL 符号开头也保持安全格式', async () => {
    vi.resetModules();
    vi.doMock('node:crypto', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:crypto')>()),
      randomBytes: (size: number) => Buffer.alloc(size, 0xfc),
    }));
    const isolatedRegistry = await import('./registry.js');
    const compiler: WebpackCompilerLike = {
      options: { mode: 'development', context: process.cwd() },
    };
    const session = isolatedRegistry.createWebpackAdapterSession(
      compiler,
      { browserTransport: 'none' },
      17,
      '5.99.0',
      WebSourceInspectorWebpackPlugin.loaderPath,
    );

    try {
      expect(session.compilerSessionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
    } finally {
      isolatedRegistry.disposeWebpackAdapterSession(compiler);
      vi.doUnmock('node:crypto');
      vi.resetModules();
    }
  });

  it('模块重新加载后仍能按 compiler 取得同一 session', async () => {
    const compiler: WebpackCompilerLike = {
      options: { mode: 'development', context: process.cwd() },
    };
    const session = createWebpackAdapterSession(
      compiler,
      { browserTransport: 'none' },
      17,
      '5.99.0',
      WebSourceInspectorWebpackPlugin.loaderPath,
    );

    try {
      vi.resetModules();
      const duplicateRegistry = await import('./registry.js');
      expect(duplicateRegistry.getWebpackAdapterSession(compiler)).toBe(session);
    } finally {
      disposeWebpackAdapterSession(compiler);
    }
  });

  it('检测到不兼容的全局 registry 版本时 fail-closed', () => {
    const globalScope = globalThis as unknown as Record<PropertyKey, unknown>;
    const originalRegistry = globalScope[REGISTRY_SYMBOL];
    globalScope[REGISTRY_SYMBOL] = {
      schemaVersion: 999,
      adapterVersion: 'incompatible',
      compilerSessions: new WeakMap(),
    };
    try {
      expect(() =>
        getWebpackAdapterSession({ options: { mode: 'development' } }),
      ).toThrow(/registry.*版本|版本.*registry/i);
    } finally {
      if (originalRegistry === undefined) {
        delete globalScope[REGISTRY_SYMBOL];
      } else {
        globalScope[REGISTRY_SYMBOL] = originalRegistry;
      }
    }
  });
});
