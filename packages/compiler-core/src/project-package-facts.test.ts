import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canResolveProjectPackageSpecifier,
  findProjectPackageFact,
  readProjectPackageFact,
} from './index.js';

const temporaryWorkspaces: string[] = [];

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createWorkspace(): string {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'wsi-package-facts-'));
  temporaryWorkspaces.push(workspaceRoot);
  writeJson(path.join(workspaceRoot, 'package.json'), {
    name: 'fixture-project',
    version: '1.0.0',
    scripts: { dev: 'vite' },
    peerDependencies: { vue: '^3.2.0' },
    engines: { node: '>=18.0.0', npm: '>=9' },
  });
  writeJson(path.join(workspaceRoot, 'node_modules', '@vue', 'cli-service', 'package.json'), {
    name: '@vue/cli-service',
    version: '5.0.8',
  });
  writeJson(path.join(
    workspaceRoot,
    'node_modules',
    '@vue',
    'cli-service',
    'node_modules',
    'webpack',
    'package.json',
  ), {
    name: 'webpack',
    version: '5.98.0',
  });
  writeJson(path.join(workspaceRoot, 'node_modules', 'vue', 'package.json'), {
    name: 'vue',
    version: '3.5.0',
    exports: { './compiler-sfc': './compiler-sfc.js' },
  });
  writeFileSync(path.join(workspaceRoot, 'node_modules', 'vue', 'compiler-sfc.js'), 'module.exports = {};\n');
  return workspaceRoot;
}

afterEach(() => {
  for (const workspaceRoot of temporaryWorkspaces.splice(0)) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

describe('project package facts', () => {
  it('只导出兼容性需要的 manifest 字段，并始终使用 workspace 相对路径', () => {
    const workspaceRoot = createWorkspace();
    const fact = readProjectPackageFact(workspaceRoot);

    expect(fact).toEqual({
      name: 'fixture-project',
      version: '1.0.0',
      peerDependencies: { vue: '^3.2.0' },
      engines: { node: '>=18.0.0' },
      packageJsonPath: 'package.json',
    });
    expect(JSON.stringify(fact)).not.toContain(workspaceRoot);
  });

  it('从 package anchor 查找逻辑 workspace node_modules 中的嵌套依赖', () => {
    const workspaceRoot = createWorkspace();
    const cliService = findProjectPackageFact(workspaceRoot, '@vue/cli-service');
    const webpack = findProjectPackageFact(workspaceRoot, 'webpack', {
      anchor: cliService,
    });

    expect(cliService?.packageJsonPath).toBe('node_modules/@vue/cli-service/package.json');
    expect(webpack).toMatchObject({
      name: 'webpack',
      version: '5.98.0',
      packageJsonPath: 'node_modules/@vue/cli-service/node_modules/webpack/package.json',
    });
    expect(JSON.stringify(webpack)).not.toContain(workspaceRoot);
  });

  it('只在已有逻辑 package anchor 时解析 subpath，且拒绝越界路径', () => {
    const workspaceRoot = createWorkspace();
    const vue = findProjectPackageFact(workspaceRoot, 'vue');

    expect(canResolveProjectPackageSpecifier(workspaceRoot, 'vue/compiler-sfc', {
      anchor: vue,
    })).toBe(true);
    expect(canResolveProjectPackageSpecifier(workspaceRoot, 'node:fs')).toBe(false);
    expect(readProjectPackageFact(workspaceRoot, '../outside/package.json')).toBeUndefined();
    expect(findProjectPackageFact(workspaceRoot, '../webpack')).toBeUndefined();
  });
});
