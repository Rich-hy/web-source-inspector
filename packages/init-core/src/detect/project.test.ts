import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject } from './project';

const packageRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const basicFixture = path.join(packageRoot, 'fixtures', 'vue-vite-basic');
const temporaryWorkspaces: string[] = [];

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writePackage(
  workspaceRoot: string,
  relativeDirectory: string,
  name: string,
  version: string,
): void {
  writeJson(path.join(workspaceRoot, relativeDirectory, 'package.json'), { name, version });
}

function createVueCliFixture(
  vueVersion = '2.6.14',
  compilerVersion = vueVersion,
): string {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'wsi-detect-vue-cli-'));
  temporaryWorkspaces.push(workspaceRoot);
  writeJson(path.join(workspaceRoot, 'package.json'), {
    scripts: { serve: 'vue-cli-service serve' },
  });
  writePackage(workspaceRoot, 'node_modules/vue', 'vue', vueVersion);
  writePackage(
    workspaceRoot,
    'node_modules/vue-template-compiler',
    'vue-template-compiler',
    compilerVersion,
  );
  writePackage(
    workspaceRoot,
    'node_modules/@vue/cli-service',
    '@vue/cli-service',
    '5.0.8',
  );

  // 模拟 pnpm 未提升的 Vue CLI 传递依赖。
  const cliServiceDependencies = 'node_modules/@vue/cli-service/node_modules';
  writePackage(workspaceRoot, `${cliServiceDependencies}/webpack`, 'webpack', '5.94.0');
  writePackage(workspaceRoot, `${cliServiceDependencies}/vue-loader`, 'vue-loader', '15.11.1');
  writePackage(
    workspaceRoot,
    `${cliServiceDependencies}/webpack-dev-server`,
    'webpack-dev-server',
    '4.15.2',
  );
  return workspaceRoot;
}

afterEach(() => {
  for (const workspaceRoot of temporaryWorkspaces.splice(0)) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

describe('detectProject', () => {
  it('识别 Vue 3 Vite fixture 并仅输出 workspace 相对路径', () => {
    const profile = detectProject({ workspaceRoot: basicFixture });

    expect(profile).toMatchObject({
      schemaVersion: 1,
      workspaceRoot: '.',
      packageManifest: 'package.json',
      bundler: 'vite',
      adapter: 'vite-vue3',
      blocked: false,
    });
    expect(profile.vue?.version).toMatch(/^3\./u);
    expect(profile.vite?.version).toMatch(/^6\./u);
    expect(profile.viteVuePlugin?.name).toBe('@vitejs/plugin-vue');
    expect(profile.configFiles).toContainEqual({
      path: 'vite.config.ts',
      moduleKind: 'typescript',
    });
    expect(profile.devCommands).toContainEqual({
      scriptName: 'dev',
      command: 'vite',
      bundler: 'vite',
      continuous: true,
    });
    expect(JSON.stringify(profile)).not.toContain(path.resolve(basicFixture));
  });

  it('从 Vue CLI 自身解析未提升的 Webpack 依赖并输出相对路径', () => {
    const workspaceRoot = createVueCliFixture();

    const profile = detectProject({ workspaceRoot });

    expect(profile).toMatchObject({
      bundler: 'vue-cli',
      adapter: 'webpack-vue2',
      blocked: false,
      webpack: {
        name: 'webpack',
        version: '5.94.0',
        packageJsonPath: 'node_modules/@vue/cli-service/node_modules/webpack/package.json',
      },
      vueLoader: {
        name: 'vue-loader',
        version: '15.11.1',
        packageJsonPath: 'node_modules/@vue/cli-service/node_modules/vue-loader/package.json',
      },
      webpackDevServer: {
        name: 'webpack-dev-server',
        version: '4.15.2',
        packageJsonPath: 'node_modules/@vue/cli-service/node_modules/webpack-dev-server/package.json',
      },
    });
    expect(JSON.stringify(profile)).not.toContain(workspaceRoot);
  });

  it('阻断 Vue 2.6 与 template compiler 的 patch 版本不一致', () => {
    const workspaceRoot = createVueCliFixture('2.6.14', '2.6.13');

    const profile = detectProject({ workspaceRoot });

    expect(profile.blocked).toBe(true);
    expect(profile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'VUE_COMPILER_VERSION_MISMATCH',
      blocking: true,
    }));
  });
});
