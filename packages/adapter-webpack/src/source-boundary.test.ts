import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyWebpackSource,
  createWebpackSourceBoundary,
  resolveWebpackWorkspaceRoot,
} from './source-boundary.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Webpack source boundary', () => {
  it('将 projectRoot 与自动发现的 workspaceRoot 分开', () => {
    const workspaceRoot = createTemporaryDirectory('wsi-webpack-workspace-');
    const projectRoot = path.join(workspaceRoot, 'apps', 'web');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['apps/*'] }),
      'utf8',
    );
    writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'web' }), 'utf8');

    expect(resolveWebpackWorkspaceRoot(projectRoot)).toBe(workspaceRoot);
  });

  it('只转换 canonical workspace 源码，并旁路依赖、外部链接与无法解析路径', () => {
    const workspaceRoot = createTemporaryDirectory('wsi-webpack-boundary-');
    const projectRoot = path.join(workspaceRoot, 'apps', 'web');
    const localSource = writeVueFile(path.join(projectRoot, 'src', 'App.vue'));
    const dependencySource = writeVueFile(
      path.join(workspaceRoot, 'node_modules', 'dependency', 'Dependency.vue'),
    );
    const pnpmDependencySource = writeVueFile(
      path.join(
        workspaceRoot,
        'node_modules',
        '.pnpm',
        'dependency@1.0.0',
        'node_modules',
        'dependency',
        'PnpmDependency.vue',
      ),
    );
    const linkedSource = writeVueFile(path.join(workspaceRoot, 'packages', 'linked', 'Linked.vue'));
    const linkedRequestDirectory = path.join(
      workspaceRoot,
      'node_modules',
      '@workspace',
      'linked',
    );
    mkdirSync(path.dirname(linkedRequestDirectory), { recursive: true });
    createDirectoryLink(path.dirname(linkedSource), linkedRequestDirectory);

    const externalRoot = createTemporaryDirectory('wsi-webpack-external-');
    writeVueFile(path.join(externalRoot, 'External.vue'));
    const externalRequestDirectory = path.join(workspaceRoot, 'src', 'external');
    mkdirSync(path.dirname(externalRequestDirectory), { recursive: true });
    createDirectoryLink(externalRoot, externalRequestDirectory);

    const boundary = createWebpackSourceBoundary(projectRoot, workspaceRoot);
    expect(classifyWebpackSource(boundary, localSource)).toMatchObject({
      kind: 'inspectable',
      relativePath: 'apps/web/src/App.vue',
    });
    expect(classifyWebpackSource(boundary, dependencySource)).toMatchObject({ kind: 'dependency' });
    expect(classifyWebpackSource(boundary, pnpmDependencySource)).toMatchObject({ kind: 'dependency' });
    expect(classifyWebpackSource(boundary, path.join(linkedRequestDirectory, 'Linked.vue'))).toMatchObject({
      kind: 'inspectable',
      relativePath: 'packages/linked/Linked.vue',
    });
    expect(classifyWebpackSource(boundary, path.join(externalRequestDirectory, 'External.vue'))).toMatchObject({
      kind: 'outside',
    });
    expect(classifyWebpackSource(boundary, path.join(projectRoot, 'src', 'Missing.vue'))).toEqual({
      kind: 'unresolved',
    });

  });
});

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeVueFile(filename: string): string {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, '<template><div /></template>', 'utf8');
  return filename;
}

function createDirectoryLink(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
