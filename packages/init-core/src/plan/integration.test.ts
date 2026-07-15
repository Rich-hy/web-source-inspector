import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorProject } from '../doctor/project';
import { captureTarget, resolveWorkspaceContext } from '../filesystem/identity';
import { integrationStateFingerprint, type IntegrationState } from '../state/types';
import { projectRuntimePaths } from '../transaction/runtime';
import { digestCanonical, sha256 } from '../digest';
import { applyIntegrationPlan } from './apply';
import { createIntegrationPlan } from './integration';
import { applyRemovalPlan } from './remove-apply';
import { createRemovalPlan } from './removal';

const workspaces: string[] = [];

interface TestFileMetadata {
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
}

function captureTestMetadata(filePath: string): TestFileMetadata | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }
  const stats = lstatSync(filePath);
  return {
    uid: stats.uid,
    gid: stats.gid,
    atimeMs: stats.atimeMs,
    mtimeMs: stats.mtimeMs,
  };
}

function journalMetadataField(metadata: TestFileMetadata | undefined): object {
  return metadata ? { beforeMetadata: metadata } : {};
}

function writePrivateFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600);
  }
}

function writePackage(
  workspaceRoot: string,
  name: string,
  version: string,
  options: {
    peerDependencies?: Record<string, string>;
    engines?: Record<string, string>;
  } = {},
): void {
  const packageDirectory = path.join(workspaceRoot, 'node_modules', ...name.split('/'));
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({
    name,
    version,
    main: 'index.js',
    ...(options.peerDependencies ? { peerDependencies: options.peerDependencies } : {}),
    ...(options.engines ? { engines: options.engines } : {}),
  }), 'utf8');
  writeFileSync(path.join(packageDirectory, 'index.js'), 'module.exports = {}\n', 'utf8');
}

function createViteWorkspace(): string {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'wsi-init-core-'));
  workspaces.push(workspaceRoot);
  writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'fixture',
    private: true,
    scripts: { dev: 'vite' },
  }), 'utf8');
  writeFileSync(path.join(workspaceRoot, 'package-lock.json'), '{}\n', 'utf8');
  writePackage(workspaceRoot, 'vue', '3.5.0');
  writePackage(workspaceRoot, 'vite', '6.0.0');
  writePackage(workspaceRoot, '@vitejs/plugin-vue', '5.2.0', {
    peerDependencies: { vite: '^5.0.0 || ^6.0.0', vue: '^3.2.0' },
  });
  writePackage(workspaceRoot, '@vue/compiler-sfc', '3.5.0');
  writePackage(workspaceRoot, '@vue/compiler-dom', '3.5.0');
  writeFileSync(path.join(workspaceRoot, 'vite.config.ts'), `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
})
`, 'utf8');
  return workspaceRoot;
}

function createWebpackWorkspace(vueCli: boolean): string {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'wsi-init-core-webpack-'));
  workspaces.push(workspaceRoot);
  writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'webpack-fixture',
    private: true,
    scripts: vueCli
      ? { serve: 'vue-cli-service serve' }
      : { dev: 'webpack --watch' },
  }), 'utf8');
  writeFileSync(path.join(workspaceRoot, 'package-lock.json'), '{}\n', 'utf8');
  writePackage(workspaceRoot, 'vue', '3.5.0');
  writePackage(workspaceRoot, 'webpack', '5.95.0');
  writePackage(workspaceRoot, 'vue-loader', '17.4.2', {
    peerDependencies: { webpack: '^5.0.0', vue: '^3.2.0' },
  });
  writePackage(workspaceRoot, '@vue/compiler-sfc', '3.5.0');
  writePackage(workspaceRoot, '@vue/compiler-dom', '3.5.0');
  if (vueCli) {
    writePackage(workspaceRoot, '@vue/cli-service', '5.0.8');
    writePackage(workspaceRoot, 'webpack-dev-server', '4.15.2');
  } else {
    writeFileSync(path.join(workspaceRoot, 'webpack.config.js'), `const { VueLoaderPlugin } = require('vue-loader')
module.exports = {
  mode: 'development',
  module: { rules: [{ test: /\\.vue$/, use: ['vue-loader'] }] },
  plugins: [new VueLoaderPlugin()]
}
`, 'utf8');
  }
  return workspaceRoot;
}

afterEach(() => {
  for (const workspaceRoot of workspaces.splice(0)) {
    try {
      const context = resolveWorkspaceContext(workspaceRoot);
      rmSync(projectRuntimePaths(context).directory, { recursive: true, force: true });
    } catch {
      // 测试清理不掩盖原断言。
    }
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

describe('integration lifecycle', () => {
  it('applies idempotently and removes only initializer-owned Vite nodes', () => {
    const workspaceRoot = createViteWorkspace();
    const plan = createIntegrationPlan({ workspaceRoot });

    expect(plan.blocked).toBe(false);
    expect(plan.edits.map((edit) => edit.path)).toEqual([
      'vite.config.ts',
      '.web-source-inspector.json',
    ]);
    expect(JSON.stringify(plan.edits.map((edit) => edit.target))).not.toContain(workspaceRoot);

    const applied = applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest });
    expect(applied).toMatchObject({ ok: true });
    expect(applied.changedFiles).toEqual([
      'vite.config.ts',
      '.web-source-inspector.json',
    ]);
    const configured = readFileSync(path.join(workspaceRoot, 'vite.config.ts'), 'utf8');
    expect(configured.indexOf('webSourceInspector()')).toBeLessThan(configured.indexOf('vue()'));
    const state = readFileSync(path.join(workspaceRoot, '.web-source-inspector.json'), 'utf8');
    expect(state).not.toContain(workspaceRoot);
    expect(state).not.toMatch(/token|sourceContent/iu);

    expect(createIntegrationPlan({ workspaceRoot })).toMatchObject({
      blocked: false,
      noOp: true,
      edits: [],
    });

    const removePlan = createRemovalPlan({ workspaceRoot });
    expect(removePlan.blocked).toBe(false);
    const removed = applyRemovalPlan({
      workspaceRoot,
      planDigest: removePlan.planDigest,
    });
    expect(removed.ok).toBe(true);
    expect(existsSync(path.join(workspaceRoot, '.web-source-inspector.json'))).toBe(false);
    expect(readFileSync(path.join(workspaceRoot, 'vite.config.ts'), 'utf8'))
      .not.toContain('webSourceInspector');
  });

  it('generates and replays a same-machine Vite browserAccess migration for created nodes', () => {
    const workspaceRoot = createViteWorkspace();
    const initialPlan = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({
      workspaceRoot,
      planDigest: initialPlan.planDigest,
    }).ok).toBe(true);

    const answers = { browserAccess: 'same-machine' };
    const migration = createIntegrationPlan({ workspaceRoot, answers });
    const pluginOperation = migration.edits.find((edit) => edit.path === 'vite.config.ts')?.operations
      .find((operation) => operation.kind === 'plugin');

    expect(migration).toMatchObject({
      blocked: false,
      normalizedAnswers: answers,
    });
    expect(pluginOperation).toMatchObject({
      ownership: 'created',
      controlledMutation: {
        kind: 'vite-browser-access',
        targetMode: 'same-machine',
      },
    });
    expect(applyIntegrationPlan({
      workspaceRoot,
      answers,
      planDigest: migration.planDigest,
    }).ok).toBe(true);

    const configured = readFileSync(path.join(workspaceRoot, 'vite.config.ts'), 'utf8');
    const state = JSON.parse(readFileSync(
      path.join(workspaceRoot, '.web-source-inspector.json'),
      'utf8',
    )) as IntegrationState;
    const pluginNode = state.nodes.find((node) => node.kind === 'plugin');
    expect(configured).toMatch(/browserAccess:\s*["']same-machine["']/u);
    expect(pluginNode).toMatchObject({
      ownership: 'created',
      details: { browserAccessMode: 'same-machine' },
    });
    expect(pluginNode?.details?.browserAccessOriginalShape).toBeUndefined();
    expect(pluginNode?.details?.browserAccessOriginalFingerprint).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain('controlledMutation');

    const missingAnswer = applyIntegrationPlan({
      workspaceRoot,
      planDigest: migration.planDigest,
    });
    const changedAnswer = applyIntegrationPlan({
      workspaceRoot,
      answers: { browserAccess: 'loopback' },
      planDigest: migration.planDigest,
    });
    expect(missingAnswer).toMatchObject({ ok: false, errorCode: 'PLAN_STALE', changedFiles: [] });
    expect(changedAnswer).toMatchObject({ ok: false, errorCode: 'PLAN_STALE', changedFiles: [] });
    expect(readFileSync(path.join(workspaceRoot, 'vite.config.ts'), 'utf8')).toBe(configured);

    const removal = createRemovalPlan({ workspaceRoot });
    expect(removal).toMatchObject({ blocked: false });
    expect(applyRemovalPlan({ workspaceRoot, planDigest: removal.planDigest }).ok).toBe(true);
    expect(readFileSync(path.join(workspaceRoot, 'vite.config.ts'), 'utf8'))
      .not.toContain('webSourceInspector');
  });

  it('preserves the first reused Vite browserAccess shape through repeated migrations', () => {
    const workspaceRoot = createViteWorkspace();
    const configPath = path.join(workspaceRoot, 'vite.config.ts');
    writeFileSync(configPath, `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { webSourceInspector } from 'web-source-inspector/vite'

export default defineConfig({
  plugins: [webSourceInspector(), vue()],
})
`, 'utf8');
    const initial = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: initial.planDigest }).ok).toBe(true);

    const sameMachine = { browserAccess: 'same-machine' };
    const firstMigration = createIntegrationPlan({ workspaceRoot, answers: sameMachine });
    expect(applyIntegrationPlan({
      workspaceRoot,
      answers: sameMachine,
      planDigest: firstMigration.planDigest,
    }).ok).toBe(true);

    const loopback = { browserAccess: 'loopback' };
    const secondMigration = createIntegrationPlan({ workspaceRoot, answers: loopback });
    expect(applyIntegrationPlan({
      workspaceRoot,
      answers: loopback,
      planDigest: secondMigration.planDigest,
    }).ok).toBe(true);

    const state = JSON.parse(readFileSync(
      path.join(workspaceRoot, '.web-source-inspector.json'),
      'utf8',
    )) as IntegrationState;
    const pluginNode = state.nodes.find((node) => node.kind === 'plugin');
    expect(pluginNode).toMatchObject({
      ownership: 'reused',
      details: {
        browserAccessMode: 'loopback',
        browserAccessOriginalShape: 'no-arguments',
      },
    });

    const removal = createRemovalPlan({ workspaceRoot });
    expect(removal).toMatchObject({ blocked: false });
    expect(applyRemovalPlan({ workspaceRoot, planDigest: removal.planDigest }).ok).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toContain('webSourceInspector()');
    expect(readFileSync(configPath, 'utf8')).not.toContain('browserAccess');
  });

  it('rejects browserAccess answers for non-Vite projects without planning writes', () => {
    const workspaceRoot = createWebpackWorkspace(false);

    const plan = createIntegrationPlan({
      workspaceRoot,
      answers: { browserAccess: 'same-machine' },
    });

    expect(plan).toMatchObject({ blocked: true, edits: [] });
    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_ANSWER' }),
    ]));
    expect(existsSync(path.join(workspaceRoot, '.web-source-inspector.json'))).toBe(false);
  });

  it('does not bypass a recorded Vite plugin fingerprint during browserAccess migration', () => {
    const workspaceRoot = createViteWorkspace();
    const initial = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: initial.planDigest }).ok).toBe(true);
    const configPath = path.join(workspaceRoot, 'vite.config.ts');
    const changed = readFileSync(configPath, 'utf8').replace(
      'webSourceInspector()',
      'webSourceInspector({ enabled: true })',
    );
    writeFileSync(configPath, changed, 'utf8');

    const migration = createIntegrationPlan({
      workspaceRoot,
      answers: { browserAccess: 'same-machine' },
    });

    expect(migration).toMatchObject({ blocked: true, edits: [] });
    expect(migration.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TRANSACTION_CONFLICT' }),
    ]));
    expect(readFileSync(configPath, 'utf8')).toBe(changed);
  });

  it('returns PLAN_STALE without overwriting a changed config', () => {
    const workspaceRoot = createViteWorkspace();
    const plan = createIntegrationPlan({ workspaceRoot });
    appendFileSync(path.join(workspaceRoot, 'vite.config.ts'), '\n// user change\n', 'utf8');

    const result = applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest });

    expect(result).toMatchObject({ ok: false, errorCode: 'PLAN_STALE' });
    expect(readFileSync(path.join(workspaceRoot, 'vite.config.ts'), 'utf8'))
      .toContain('// user change');
    expect(existsSync(path.join(workspaceRoot, '.web-source-inspector.json'))).toBe(false);
  });

  it('requires normalized answers when apply replays an answer-dependent plan', () => {
    const workspaceRoot = createWebpackWorkspace(false);
    const answers = { allowedOrigin: 'http://localhost:8080' };
    const plan = createIntegrationPlan({ workspaceRoot, answers });

    const result = applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest });

    expect(result).toMatchObject({ ok: false, errorCode: 'PLAN_CONTEXT_REQUIRED' });
    expect(readFileSync(path.join(workspaceRoot, 'webpack.config.js'), 'utf8'))
      .not.toContain('web-source-inspector');

    const emptyAnswers = applyIntegrationPlan({
      workspaceRoot,
      answers: {},
      planDigest: plan.planDigest,
    });
    expect(emptyAnswers).toMatchObject({ ok: false, errorCode: 'PLAN_CONTEXT_REQUIRED' });
  });

  it('applies raw Webpack with an explicit origin and removes owned nodes', () => {
    const workspaceRoot = createWebpackWorkspace(false);
    const answers = { allowedOrigin: 'http://localhost:8080' };
    const plan = createIntegrationPlan({ workspaceRoot, answers });

    expect(plan).toMatchObject({ blocked: false });
    expect(plan.profile.bundler).toBe('webpack');
    expect(plan.edits[0]?.afterContent).toContain('browserTransport: "raw"');
    expect(applyIntegrationPlan({
      workspaceRoot,
      answers,
      planDigest: plan.planDigest,
    }).ok).toBe(true);
    expect(createIntegrationPlan({ workspaceRoot, answers })).toMatchObject({ noOp: true });

    const removal = createRemovalPlan({ workspaceRoot });
    expect(removal.blocked).toBe(false);
    expect(applyRemovalPlan({ workspaceRoot, planDigest: removal.planDigest }).ok).toBe(true);
    expect(readFileSync(path.join(workspaceRoot, 'webpack.config.js'), 'utf8'))
      .not.toContain('web-source-inspector');
  });

  it('creates and later removes an initializer-owned standard Vue CLI config', () => {
    const workspaceRoot = createWebpackWorkspace(true);
    const plan = createIntegrationPlan({ workspaceRoot });

    expect(plan).toMatchObject({ blocked: false });
    expect(plan.profile.bundler).toBe('vue-cli');
    expect(plan.edits.map((edit) => edit.path)).toEqual([
      'vue.config.js',
      '.web-source-inspector.json',
    ]);
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);
    expect(createIntegrationPlan({ workspaceRoot })).toMatchObject({ noOp: true });

    const removal = createRemovalPlan({ workspaceRoot });
    expect(removal.blocked).toBe(false);
    expect(applyRemovalPlan({ workspaceRoot, planDigest: removal.planDigest }).ok).toBe(true);
    expect(existsSync(path.join(workspaceRoot, 'vue.config.js'))).toBe(false);
  });

  it('changes workspace identity when the root directory is recreated at the same path', () => {
    const workspaceRoot = createViteWorkspace();
    const first = resolveWorkspaceContext(workspaceRoot);
    rmSync(workspaceRoot, { recursive: true, force: true });
    mkdirSync(workspaceRoot);

    const second = resolveWorkspaceContext(workspaceRoot);

    expect(second.rootIdentity).not.toBe(first.rootIdentity);
  });

  it('rejects workspace config files with multiple hard links', () => {
    const workspaceRoot = createViteWorkspace();
    linkSync(
      path.join(workspaceRoot, 'vite.config.ts'),
      path.join(workspaceRoot, 'vite.config.hardlink.ts'),
    );

    const plan = createIntegrationPlan({ workspaceRoot });

    expect(plan.blocked).toBe(true);
    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PATH_REJECTED' }),
    ]));
  });

  it('preserves an existing config file mode across atomic replacement', () => {
    const workspaceRoot = createViteWorkspace();
    const configPath = path.join(workspaceRoot, 'vite.config.ts');
    chmodSync(configPath, 0o640);
    if (process.platform !== 'win32') {
      utimesSync(configPath, new Date('2001-02-03T04:05:06.000Z'), new Date('2002-03-04T05:06:07.000Z'));
    }
    const beforeStats = lstatSync(configPath);
    const beforeMode = lstatSync(configPath).mode & 0o777;
    const plan = createIntegrationPlan({ workspaceRoot });

    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);

    const afterStats = lstatSync(configPath);
    expect(afterStats.mode & 0o777).toBe(beforeMode);
    if (process.platform !== 'win32') {
      expect(afterStats.uid).toBe(beforeStats.uid);
      expect(afterStats.gid).toBe(beforeStats.gid);
      expect(Math.abs(afterStats.mtimeMs - beforeStats.mtimeMs)).toBeLessThanOrEqual(2);
    }
  });

  it('persists a multi-phase journal across NTFS atomic replacement', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const workspaceRoot = createViteWorkspace();
    const context = resolveWorkspaceContext(workspaceRoot);
    const runtime = projectRuntimePaths(context);
    const plan = createIntegrationPlan({ workspaceRoot });

    const result = applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest });

    expect(result.ok).toBe(true);
    expect(existsSync(runtime.journalPath)).toBe(false);
  });

  it('rejects integration state maps that do not reference every config file', () => {
    const workspaceRoot = createViteWorkspace();
    const plan = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);
    const statePath = path.join(workspaceRoot, '.web-source-inspector.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      configModules: Record<string, string>;
    };
    delete state.configModules['vite.config.ts'];
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');

    const removal = createRemovalPlan({ workspaceRoot });

    expect(removal.blocked).toBe(true);
    expect(removal.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TRANSACTION_CONFLICT' }),
    ]));
  });

  it('does not recreate a recorded node that disappeared from the current config', () => {
    const workspaceRoot = createViteWorkspace();
    const plan = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);
    const configPath = path.join(workspaceRoot, 'vite.config.ts');
    const changed = readFileSync(configPath, 'utf8').replace('webSourceInspector(), ', '');
    writeFileSync(configPath, changed, 'utf8');

    const replay = createIntegrationPlan({ workspaceRoot });

    expect(replay.blocked).toBe(true);
    expect(replay.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TRANSACTION_CONFLICT' }),
    ]));
    expect(readFileSync(configPath, 'utf8')).toBe(changed);
  });

  it('binds the state-file fingerprint to canonical state content', () => {
    const workspaceRoot = createViteWorkspace();
    const plan = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);
    const statePath = path.join(workspaceRoot, '.web-source-inspector.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      package: { version: string };
    };
    state.package.version = '9.9.9';
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');

    expect(createRemovalPlan({ workspaceRoot }).blocked).toBe(true);
  });

  it('rejects legacy state that claims created ownership', () => {
    const workspaceRoot = createViteWorkspace();
    const plan = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);
    const statePath = path.join(workspaceRoot, '.web-source-inspector.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      stateFile: { fingerprint: string };
    };
    state.stateFile.fingerprint = digestCanonical(['state-file', 1]);
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');

    expect(createRemovalPlan({ workspaceRoot }).blocked).toBe(true);
    const migration = createIntegrationPlan({ workspaceRoot });
    expect(migration).toMatchObject({ blocked: true, edits: [] });
  });

  it('migrates only an all-reused legacy state and drops state-file delete ownership', () => {
    const workspaceRoot = createViteWorkspace();
    writeFileSync(path.join(workspaceRoot, 'vite.config.ts'), `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { webSourceInspector } from 'web-source-inspector/vite'

export default defineConfig({
  plugins: [webSourceInspector(), vue()],
})
`, 'utf8');
    const plan = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);
    const statePath = path.join(workspaceRoot, '.web-source-inspector.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as IntegrationState;
    expect(state.nodes.every((node) => node.ownership === 'reused')).toBe(true);
    expect(Object.values(state.configFileOwnership).every((item) => item === 'reused')).toBe(true);
    state.stateFile.fingerprint = digestCanonical(['state-file', 1]);
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');

    expect(createRemovalPlan({ workspaceRoot }).blocked).toBe(true);
    const migration = createIntegrationPlan({ workspaceRoot });
    expect(migration).toMatchObject({ blocked: false });
    expect(migration.edits.map((edit) => edit.path)).toEqual(['.web-source-inspector.json']);
    const migratedState = JSON.parse(
      migration.edits[0]?.afterContent ?? '',
    ) as IntegrationState;
    expect(migratedState.stateFile.ownership).toBe('reused');
  });

  it('rejects adapter and bundler version fields that contradict the detected state', () => {
    const workspaceRoot = createViteWorkspace();
    const plan = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);
    const statePath = path.join(workspaceRoot, '.web-source-inspector.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as IntegrationState;
    state.adapter = 'vite-vue2';
    delete state.profile.viteVersion;
    state.stateFile.fingerprint = integrationStateFingerprint(state);
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');

    expect(createRemovalPlan({ workspaceRoot }).blocked).toBe(true);
  });

  it('rejects kind-incompatible state details with a valid content fingerprint', () => {
    const workspaceRoot = createViteWorkspace();
    const plan = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);
    const statePath = path.join(workspaceRoot, '.web-source-inspector.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as IntegrationState;
    const pluginNode = state.nodes.find((node) => node.kind === 'plugin');
    expect(pluginNode).toBeDefined();
    if (!pluginNode) {
      return;
    }
    pluginNode.details = { ...pluginNode.details, hookName: 'before' };
    state.stateFile.fingerprint = integrationStateFingerprint(state);
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');

    expect(createRemovalPlan({ workspaceRoot }).blocked).toBe(true);
  });

  it('rejects coerced but non-semver state versions', () => {
    const workspaceRoot = createViteWorkspace();
    const plan = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);
    const statePath = path.join(workspaceRoot, '.web-source-inspector.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as IntegrationState;
    state.profile.vueVersion = `release-${state.profile.vueVersion}`;
    state.stateFile.fingerprint = integrationStateFingerprint(state);
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');

    expect(createRemovalPlan({ workspaceRoot }).blocked).toBe(true);
  });

  it('doctor reports current incompatibility without blocking removal of recorded state', () => {
    const workspaceRoot = createViteWorkspace();
    const plan = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);
    writeFileSync(path.join(workspaceRoot, 'node_modules', 'vite', 'package.json'), JSON.stringify({
      name: 'vite',
      version: '7.0.0',
      main: 'index.js',
    }), 'utf8');

    const doctor = doctorProject({ workspaceRoot });
    const removal = createRemovalPlan({ workspaceRoot });

    expect(doctor).toMatchObject({
      ok: false,
      configured: true,
      errorCode: 'TARGET_UNSUPPORTED',
    });
    expect(removal.blocked).toBe(false);
    expect(applyRemovalPlan({
      workspaceRoot,
      planDigest: removal.planDigest,
    }).ok).toBe(true);
  });

  it('doctor restores a journaled after-image only when digest and identity match', () => {
    const workspaceRoot = createViteWorkspace();
    const context = resolveWorkspaceContext(workspaceRoot);
    const runtime = projectRuntimePaths(context);
    const before = captureTarget(context, 'vite.config.ts');
    const beforeMetadata = captureTestMetadata(before.absolutePath);
    const afterContent = `${before.content}// transaction after\n`;
    const transactionId = 'a'.repeat(32);
    const tempName = `.wsi-${transactionId}-0.tmp`;
    writeFileSync(path.join(workspaceRoot, tempName), afterContent, 'utf8');
    const temp = captureTarget(context, tempName);
    renameSync(temp.absolutePath, before.absolutePath);
    const after = captureTarget(context, 'vite.config.ts');
    const snapshotName = `${transactionId}-0.snapshot`;
    writePrivateFile(
      path.join(runtime.snapshotsDirectory, snapshotName),
      before.content ?? '',
    );
    writePrivateFile(runtime.journalPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId,
      rootIdentity: context.rootIdentity,
      operation: 'init-apply',
      entries: [{
        path: 'vite.config.ts',
        tempPath: tempName,
        snapshotName,
        snapshotDigest: before.digest,
        beforeDigest: before.digest,
        afterDigest: sha256(afterContent),
        beforeExists: true,
        afterExists: true,
        beforeIdentity: before.identity.fileIdentity,
        ...journalMetadataField(beforeMetadata),
        tempIdentity: temp.identity.fileIdentity,
        afterIdentity: after.identity.fileIdentity,
        phase: 'renamed',
      }],
    })}\n`);

    const result = doctorProject({ workspaceRoot });

    expect(result).toMatchObject({ ok: true, recovered: true });
    expect(readFileSync(before.absolutePath, 'utf8')).toBe(before.content);
    expect(existsSync(runtime.journalPath)).toBe(false);
  });

  it('doctor restores a transactionally deleted state file from its private snapshot', () => {
    const workspaceRoot = createViteWorkspace();
    const plan = createIntegrationPlan({ workspaceRoot });
    expect(applyIntegrationPlan({ workspaceRoot, planDigest: plan.planDigest }).ok).toBe(true);
    const context = resolveWorkspaceContext(workspaceRoot);
    const runtime = projectRuntimePaths(context);
    const before = captureTarget(context, '.web-source-inspector.json');
    const beforeMetadata = captureTestMetadata(before.absolutePath);
    const transactionId = 'b'.repeat(32);
    const tempName = `.wsi-${transactionId}-0.tmp`;
    const snapshotName = `${transactionId}-0.snapshot`;
    writePrivateFile(
      path.join(runtime.snapshotsDirectory, snapshotName),
      before.content ?? '',
    );
    renameSync(before.absolutePath, path.join(workspaceRoot, tempName));
    const temp = captureTarget(context, tempName);
    writePrivateFile(runtime.journalPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId,
      rootIdentity: context.rootIdentity,
      operation: 'remove-apply',
      entries: [{
        path: '.web-source-inspector.json',
        tempPath: tempName,
        snapshotName,
        snapshotDigest: before.digest,
        beforeDigest: before.digest,
        afterDigest: 'ABSENT',
        beforeExists: true,
        afterExists: false,
        beforeIdentity: before.identity.fileIdentity,
        ...journalMetadataField(beforeMetadata),
        tempIdentity: temp.identity.fileIdentity,
        phase: 'renamed',
      }],
    })}\n`);

    const result = doctorProject({ workspaceRoot });

    expect(result).toMatchObject({ ok: true, recovered: true, configured: true });
    expect(readFileSync(before.absolutePath, 'utf8')).toBe(before.content);
  });

  it('doctor reports TRANSACTION_CONFLICT without overwriting an unknown current file', () => {
    const workspaceRoot = createViteWorkspace();
    const context = resolveWorkspaceContext(workspaceRoot);
    const runtime = projectRuntimePaths(context);
    const before = captureTarget(context, 'vite.config.ts');
    const beforeMetadata = captureTestMetadata(before.absolutePath);
    const afterContent = `${before.content}// expected after\n`;
    const transactionId = 'c'.repeat(32);
    const tempName = `.wsi-${transactionId}-0.tmp`;
    writeFileSync(path.join(workspaceRoot, tempName), afterContent, 'utf8');
    const temp = captureTarget(context, tempName);
    renameSync(temp.absolutePath, before.absolutePath);
    const after = captureTarget(context, 'vite.config.ts');
    const snapshotName = `${transactionId}-0.snapshot`;
    writePrivateFile(
      path.join(runtime.snapshotsDirectory, snapshotName),
      before.content ?? '',
    );
    writePrivateFile(runtime.journalPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId,
      rootIdentity: context.rootIdentity,
      operation: 'init-apply',
      entries: [{
        path: 'vite.config.ts',
        tempPath: tempName,
        snapshotName,
        snapshotDigest: before.digest,
        beforeDigest: before.digest,
        afterDigest: sha256(afterContent),
        beforeExists: true,
        afterExists: true,
        beforeIdentity: before.identity.fileIdentity,
        ...journalMetadataField(beforeMetadata),
        tempIdentity: temp.identity.fileIdentity,
        afterIdentity: after.identity.fileIdentity,
        phase: 'renamed',
      }],
    })}\n`);
    appendFileSync(before.absolutePath, '// unrelated user write\n', 'utf8');

    const result = doctorProject({ workspaceRoot });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'TRANSACTION_CONFLICT',
    });
    expect(readFileSync(before.absolutePath, 'utf8')).toContain('unrelated user write');
    expect(existsSync(runtime.journalPath)).toBe(true);
  });

  it('doctor resumes a rollback that crashed after recording rollback intent', () => {
    const workspaceRoot = createViteWorkspace();
    const context = resolveWorkspaceContext(workspaceRoot);
    const runtime = projectRuntimePaths(context);
    const before = captureTarget(context, 'vite.config.ts');
    const beforeMetadata = captureTestMetadata(before.absolutePath);
    const afterContent = `${before.content}// transaction after\n`;
    writeFileSync(before.absolutePath, afterContent, 'utf8');
    const after = captureTarget(context, 'vite.config.ts');
    const transactionId = 'd'.repeat(32);
    const snapshotName = `${transactionId}-0.snapshot`;
    writePrivateFile(path.join(runtime.snapshotsDirectory, snapshotName), before.content ?? '');
    writePrivateFile(runtime.journalPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId,
      rootIdentity: context.rootIdentity,
      operation: 'init-apply',
      entries: [{
        path: 'vite.config.ts',
        tempPath: `.wsi-${transactionId}-0.tmp`,
        snapshotName,
        snapshotDigest: before.digest,
        beforeDigest: before.digest,
        afterDigest: sha256(afterContent),
        beforeExists: true,
        afterExists: true,
        beforeIdentity: before.identity.fileIdentity,
        ...journalMetadataField(beforeMetadata),
        afterIdentity: after.identity.fileIdentity,
        phase: 'rollback-prepared',
      }],
    })}\n`);

    const result = doctorProject({ workspaceRoot });

    expect(result).toMatchObject({ ok: true, recovered: true });
    const restoredStats = lstatSync(before.absolutePath);
    if (beforeMetadata) {
      expect(restoredStats.uid).toBe(beforeMetadata.uid);
      expect(restoredStats.gid).toBe(beforeMetadata.gid);
      expect(Math.abs(restoredStats.mtimeMs - beforeMetadata.mtimeMs)).toBeLessThanOrEqual(2);
    }
    expect(readFileSync(before.absolutePath, 'utf8')).toBe(before.content);
    expect(existsSync(runtime.journalPath)).toBe(false);
  });

  it('doctor refuses an unregistered transaction temp even when its digest is expected', () => {
    const workspaceRoot = createViteWorkspace();
    const context = resolveWorkspaceContext(workspaceRoot);
    const runtime = projectRuntimePaths(context);
    const before = captureTarget(context, 'vite.config.ts');
    const beforeMetadata = captureTestMetadata(before.absolutePath);
    const afterContent = `${before.content}// staged after\n`;
    const transactionId = 'f'.repeat(32);
    const snapshotName = `${transactionId}-0.snapshot`;
    const tempName = `.wsi-${transactionId}-0.tmp`;
    writePrivateFile(path.join(runtime.snapshotsDirectory, snapshotName), before.content ?? '');
    writeFileSync(path.join(workspaceRoot, tempName), afterContent, 'utf8');
    writePrivateFile(runtime.journalPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId,
      rootIdentity: context.rootIdentity,
      operation: 'init-apply',
      entries: [{
        path: 'vite.config.ts',
        tempPath: tempName,
        snapshotName,
        snapshotDigest: before.digest,
        beforeDigest: before.digest,
        afterDigest: sha256(afterContent),
        beforeExists: true,
        afterExists: true,
        beforeIdentity: before.identity.fileIdentity,
        ...journalMetadataField(beforeMetadata),
        phase: 'prepared',
      }],
    })}\n`);

    const result = doctorProject({ workspaceRoot });

    expect(result).toMatchObject({ ok: false, errorCode: 'TRANSACTION_CONFLICT' });
    expect(existsSync(path.join(workspaceRoot, tempName))).toBe(true);
    expect(existsSync(runtime.journalPath)).toBe(true);
  });

  it('doctor accepts restored before-content after inode replacement', () => {
    const workspaceRoot = createViteWorkspace();
    const context = resolveWorkspaceContext(workspaceRoot);
    const runtime = projectRuntimePaths(context);
    const before = captureTarget(context, 'vite.config.ts');
    const beforeMetadata = captureTestMetadata(before.absolutePath);
    const afterContent = `${before.content}// staged after\n`;
    const transactionId = '1'.repeat(32);
    const tempName = `.wsi-${transactionId}-0.tmp`;
    writeFileSync(path.join(workspaceRoot, tempName), afterContent, 'utf8');
    const temp = captureTarget(context, tempName);
    const replacementPath = path.join(workspaceRoot, '.same-before.tmp');
    writeFileSync(replacementPath, before.content ?? '', 'utf8');
    renameSync(replacementPath, before.absolutePath);
    if (process.platform !== 'win32') {
      chmodSync(before.absolutePath, 0o600);
      utimesSync(
        before.absolutePath,
        new Date('2003-04-05T06:07:08.000Z'),
        new Date('2004-05-06T07:08:09.000Z'),
      );
    }
    const replacementStats = lstatSync(before.absolutePath);
    const snapshotName = `${transactionId}-0.snapshot`;
    writePrivateFile(path.join(runtime.snapshotsDirectory, snapshotName), before.content ?? '');
    writePrivateFile(runtime.journalPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId,
      rootIdentity: context.rootIdentity,
      operation: 'init-apply',
      entries: [{
        path: 'vite.config.ts',
        tempPath: tempName,
        snapshotName,
        snapshotDigest: before.digest,
        beforeDigest: before.digest,
        afterDigest: sha256(afterContent),
        beforeExists: true,
        afterExists: true,
        beforeIdentity: before.identity.fileIdentity,
        ...journalMetadataField(beforeMetadata),
        tempIdentity: temp.identity.fileIdentity,
        phase: 'temp-written',
      }],
    })}\n`);

    const result = doctorProject({ workspaceRoot });

    expect(result).toMatchObject({ ok: true, recovered: true });
    const recoveredStats = lstatSync(before.absolutePath);
    if (process.platform !== 'win32') {
      expect(recoveredStats.mode & 0o777).toBe(replacementStats.mode & 0o777);
      expect(recoveredStats.uid).toBe(replacementStats.uid);
      expect(recoveredStats.gid).toBe(replacementStats.gid);
      expect(Math.abs(recoveredStats.mtimeMs - replacementStats.mtimeMs))
        .toBeLessThanOrEqual(2);
    }
    expect(readFileSync(before.absolutePath, 'utf8')).toBe(before.content);
    expect(existsSync(path.join(workspaceRoot, tempName))).toBe(false);
    expect(existsSync(runtime.journalPath)).toBe(false);
  });

  it('rejects a pending journal that is readable by other users', () => {
    if (process.platform === 'win32') {
      return;
    }
    const workspaceRoot = createViteWorkspace();
    const context = resolveWorkspaceContext(workspaceRoot);
    const runtime = projectRuntimePaths(context);
    writePrivateFile(runtime.journalPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: 'e'.repeat(32),
      rootIdentity: context.rootIdentity,
      operation: 'init-apply',
      entries: [],
    })}\n`);
    chmodSync(runtime.journalPath, 0o644);

    const result = doctorProject({ workspaceRoot });

    expect(result).toMatchObject({ ok: false, errorCode: 'TRANSACTION_CONFLICT' });
    expect(existsSync(runtime.journalPath)).toBe(true);
  });
});
