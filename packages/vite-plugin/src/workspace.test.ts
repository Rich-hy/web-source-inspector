import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findWorkspaceRoot, shouldTransform, toWireRelativePath } from './workspace';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-vite-workspace-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeFile(filename: string, content = '<template><div /></template>'): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content, 'utf8');
}

async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('findWorkspaceRoot', () => {
  it('识别 pnpm-workspace.yaml 并返回真实路径', async () => {
    const root = await createTemporaryDirectory();
    const appRoot = path.join(root, 'packages', 'app');
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(path.join(appRoot, 'package.json'), '{"name":"app"}');

    expect(findWorkspaceRoot(appRoot)).toBe(await fs.realpath(root));
  });

  it('识别 package.json 的 workspaces 数组', async () => {
    const root = await createTemporaryDirectory();
    const appRoot = path.join(root, 'packages', 'app');
    await writeFile(path.join(root, 'package.json'), '{"private":true,"workspaces":["packages/*"]}');
    await writeFile(path.join(appRoot, 'package.json'), '{"name":"app"}');

    expect(findWorkspaceRoot(appRoot)).toBe(await fs.realpath(root));
  });

  it('识别 Yarn 旧式 workspaces.packages', async () => {
    const root = await createTemporaryDirectory();
    const appRoot = path.join(root, 'apps', 'app');
    await writeFile(
      path.join(root, 'package.json'),
      '{"private":true,"workspaces":{"packages":["apps/*"]}}'
    );
    await writeFile(path.join(appRoot, 'package.json'), '{"name":"app"}');

    expect(findWorkspaceRoot(appRoot)).toBe(await fs.realpath(root));
  });

  it('从 Junction 或 symlink 路径扫描时使用真实工作区祖先', async () => {
    const directory = await createTemporaryDirectory();
    const physicalRoot = path.join(directory, 'physical');
    const appRoot = path.join(physicalRoot, 'packages', 'app');
    const linkedRoot = path.join(directory, 'linked');
    await writeFile(path.join(physicalRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(path.join(appRoot, 'package.json'), '{"name":"app"}');
    await createDirectoryLink(physicalRoot, linkedRoot);

    expect(findWorkspaceRoot(path.join(linkedRoot, 'packages', 'app'))).toBe(
      await fs.realpath(physicalRoot)
    );
  });
});

describe('canonical source boundary', () => {
  it('仅按完整路径段排除依赖、产物和 Git 目录', async () => {
    const root = await createTemporaryDirectory();
    const sourceFile = path.join(root, 'src', 'node_modules-copy', 'Component.vue');
    const distLikeFile = path.join(root, 'src', 'dist-assets', 'Component.vue');
    const gitLikeFile = path.join(root, 'src', '.git-data', 'Component.vue');
    const dependencyFile = path.join(root, 'node_modules', 'dependency', 'Component.vue');
    const buildFile = path.join(root, 'dist', 'Component.vue');
    const gitFile = path.join(root, '.git', 'Component.vue');
    await Promise.all([
      writeFile(sourceFile),
      writeFile(distLikeFile),
      writeFile(gitLikeFile),
      writeFile(dependencyFile),
      writeFile(buildFile),
      writeFile(gitFile),
    ]);

    expect(shouldTransform(sourceFile, root, [], [], [])).toBe(true);
    expect(shouldTransform(distLikeFile, root, [], [], [])).toBe(true);
    expect(shouldTransform(gitLikeFile, root, [], [], [])).toBe(true);
    expect(shouldTransform(dependencyFile, root, [], [], [])).toBe(false);
    expect(shouldTransform(buildFile, root, [], [], [])).toBe(false);
    expect(shouldTransform(gitFile, root, [], [], [])).toBe(false);
  });

  it('在 node_modules 中的 workspace 链接使用真实源码身份', async () => {
    const root = await createTemporaryDirectory();
    const sharedFile = path.join(root, 'packages', 'shared', 'src', 'Shared.vue');
    const linkedPackage = path.join(root, 'node_modules', '@workspace', 'shared');
    await writeFile(sharedFile);
    await createDirectoryLink(path.join(root, 'packages', 'shared'), linkedPackage);
    const linkedFile = path.join(linkedPackage, 'src', 'Shared.vue');

    expect(shouldTransform(linkedFile, root, [], [], [])).toBe(true);
    expect(toWireRelativePath(root, linkedFile)).toBe('packages/shared/src/Shared.vue');
  });
});
