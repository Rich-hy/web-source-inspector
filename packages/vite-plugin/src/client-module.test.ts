import { describe, expect, it } from 'vitest';

import { createRuntimeModule } from './client-module.js';
import { resolveInspectorAssets } from './types.js';

describe('runtime virtual asset', () => {
  it('默认只引用稳定公开 Runtime 入口', () => {
    expect(createRuntimeModule(resolveInspectorAssets())).toBe(
      'export { createInspectorRuntime } from "@web-source-inspector/runtime";\n',
    );
  });

  it('允许统一公开包注入预编译 Browser Runtime ESM', () => {
    const runtimeModuleSource = 'export function createInspectorRuntime() {}\n';
    expect(createRuntimeModule(resolveInspectorAssets({ runtimeModuleSource })))
      .toBe(runtimeModuleSource);
  });
});
