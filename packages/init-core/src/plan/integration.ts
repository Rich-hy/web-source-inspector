import semver from 'semver';
import { removeViteIntegration, transformViteConfig } from '../ast/vite';
import {
  removeVueCliIntegration,
  removeWebpackIntegration,
  transformVueCliConfig,
  transformWebpackConfig,
} from '../ast/webpack';
import { digestCanonical, sha256 } from '../digest';
import { detectProject } from '../detect/project';
import {
  captureTarget,
  resolveWorkspaceContext,
  type CapturedTarget,
  type WorkspaceContext,
} from '../filesystem/identity';
import {
  IntegrationStateError,
  preserveRecordedOwnership,
  readIntegrationState,
  serializeIntegrationState,
} from '../state/io';
import {
  createIntegrationState,
  INTEGRATION_STATE_PATH,
  integrationStateFingerprint,
  legacyIntegrationStateFingerprint,
  type IntegrationState,
} from '../state/types';
import { readPendingJournal, TransactionConflictError } from '../transaction/journal';
import {
  ProjectLockError,
  withProjectLock,
  type ProjectRuntimePaths,
} from '../transaction/runtime';
import type { ConfigModuleKind, ProjectDiagnostic, ProjectProfile } from '../types';
import type {
  CreateIntegrationPlanOptions,
  AstOperation,
  BrowserAccessMode,
  IntegrationPlan,
  PlannedFileEdit,
} from './types';

const KNOWN_ANSWERS = new Set(['bundler', 'allowedOrigin', 'browserAccess']);

function normalizedAnswers(
  answers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answers ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function diagnostic(
  diagnostics: ProjectDiagnostic[],
  code: string,
  message: string,
): void {
  diagnostics.push({ code, message, severity: 'error', blocking: true });
}

function validateAnswers(
  answers: Record<string, string>,
  diagnostics: ProjectDiagnostic[],
  profile: ProjectProfile,
): void {
  for (const [key, value] of Object.entries(answers)) {
    if (!KNOWN_ANSWERS.has(key)) {
      diagnostic(diagnostics, 'INVALID_ANSWER', `未知初始化答案：${key}`);
    } else if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
      diagnostic(diagnostics, 'INVALID_ANSWER', `初始化答案 ${key} 长度无效。`);
    } else if (key === 'browserAccess'
      && value !== 'loopback'
      && value !== 'same-machine') {
      diagnostic(diagnostics, 'INVALID_ANSWER', 'browserAccess 只能是 loopback 或 same-machine。');
    } else if (key === 'browserAccess' && profile.bundler !== 'vite') {
      diagnostic(diagnostics, 'INVALID_ANSWER', 'browserAccess 仅支持 Vite 项目。');
    }
  }
}

function browserAccessAnswer(answers: Record<string, string>): BrowserAccessMode | undefined {
  const value = answers.browserAccess;
  return value === 'loopback' || value === 'same-machine' ? value : undefined;
}

function wdsMajor(profile: ProjectProfile): 3 | 4 | undefined {
  const usesDevServer = profile.bundler === 'vue-cli'
    || profile.devCommands.some((item) => item.bundler === 'webpack'
      && /(?:webpack-dev-server|webpack\s+serve)\b/u.test(item.command));
  if (!usesDevServer) {
    return undefined;
  }
  const version = profile.webpackDevServer
    ? semver.coerce(profile.webpackDevServer.version)
    : null;
  return version?.major === 3 || version?.major === 4 ? version.major : undefined;
}

function selectConfig(profile: ProjectProfile): {
  path: string;
  moduleKind: ConfigModuleKind;
  initialContent?: string;
} | undefined {
  const prefix = profile.bundler === 'vite'
    ? 'vite.config.'
    : profile.bundler === 'webpack'
      ? 'webpack.config.'
      : 'vue.config.';
  const candidates = profile.configFiles.filter((item) => item.path.startsWith(prefix));
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (profile.bundler === 'vue-cli' && candidates.length === 0) {
    return {
      path: 'vue.config.js',
      moduleKind: 'commonjs',
      initialContent: 'module.exports = {}\n',
    };
  }
  return undefined;
}

function transformConfig(
  profile: ProjectProfile,
  moduleKind: ConfigModuleKind,
  source: string,
  answers: Record<string, string>,
) {
  if (profile.bundler === 'vite') {
    return transformViteConfig(source, moduleKind, {
      browserAccess: browserAccessAnswer(answers),
    });
  }
  if (profile.bundler === 'webpack') {
    return transformWebpackConfig(source, {
      moduleKind,
      webpackDevServerMajor: wdsMajor(profile),
      allowedOrigin: answers.allowedOrigin,
    });
  }
  if (profile.bundler === 'vue-cli') {
    return transformVueCliConfig(source, {
      moduleKind,
      webpackDevServerMajor: wdsMajor(profile),
    });
  }
  return {
    ok: false,
    code: source,
    operations: [],
    errorCode: 'BUNDLER_NOT_DETECTED',
  };
}

function planEdit(
  target: CapturedTarget,
  afterContent: string,
  operations: PlannedFileEdit['operations'],
): PlannedFileEdit {
  return {
    path: target.identity.path,
    target: target.identity,
    beforeDigest: target.digest,
    afterDigest: sha256(afterContent),
    afterExists: true,
    beforeContent: target.content ?? '',
    afterContent,
    operations,
  };
}

function planDigestInput(
  profile: ProjectProfile,
  answers: Record<string, string>,
  edits: readonly PlannedFileEdit[],
  diagnostics: readonly ProjectDiagnostic[],
): unknown {
  return {
    operation: 'init-plan',
    schemaVersion: 1,
    profile,
    normalizedAnswers: answers,
    edits: edits.map(({ beforeContent: _before, afterContent: _after, ...edit }) => edit),
    diagnostics,
  };
}

function buildPlan(
  profile: ProjectProfile,
  answers: Record<string, string>,
  diagnostics: ProjectDiagnostic[],
  edits: PlannedFileEdit[],
): IntegrationPlan {
  const blocked = profile.requiredInputs.length > 0
    || diagnostics.some((item) => item.blocking);
  return {
    schemaVersion: 1,
    operation: 'init-plan',
    profile,
    normalizedAnswers: answers,
    requiredInputs: profile.requiredInputs,
    diagnostics,
    edits,
    planDigest: digestCanonical(planDigestInput(profile, answers, edits, diagnostics)),
    blocked,
    noOp: !blocked && edits.length === 0,
  };
}

function existingStateForPlan(
  target: CapturedTarget,
  diagnostics: ProjectDiagnostic[],
): IntegrationState | null {
  try {
    return readIntegrationState(target, { allowLegacyStateFingerprint: true });
  } catch (error) {
    diagnostic(
      diagnostics,
      error instanceof IntegrationStateError ? error.code : 'TRANSACTION_CONFLICT',
      '现有 .web-source-inspector.json 无法安全复用。',
    );
    return null;
  }
}

function recordedOperations(
  state: IntegrationState,
  configPath: string,
): AstOperation[] {
  return state.nodes
    .filter((node) => node.configPath === configPath)
    .map((node) => ({
      kind: node.kind,
      // init 预校验只验证节点存在，不在内存 AST 中删除 initializer-owned 节点。
      ownership: 'reused',
      fingerprint: node.fingerprint,
      description: `预校验 ${node.kind} 节点。`,
      ...(node.details ? { details: node.details } : {}),
    }));
}

function existingStateMatchesProfile(
  state: IntegrationState,
  profile: ProjectProfile,
  configPath: string,
  moduleKind: ConfigModuleKind,
): boolean {
  return state.adapter === profile.adapter
    && state.profile.bundler === profile.bundler
    && state.profile.vueVersion === profile.vue?.version
    && state.profile.viteVersion === profile.vite?.version
    && state.profile.webpackVersion === profile.webpack?.version
    && state.profile.vueLoaderVersion === profile.vueLoader?.version
    && state.configFiles.length === 1
    && state.configFiles[0] === configPath
    && state.configModules[configPath] === moduleKind;
}

function validateRecordedConfig(
  state: IntegrationState,
  target: CapturedTarget,
): boolean {
  if (!target.identity.exists || target.content === null) {
    return false;
  }
  const operations = recordedOperations(state, target.identity.path);
  const result = state.profile.bundler === 'vite'
    ? removeViteIntegration(target.content, operations)
    : state.profile.bundler === 'vue-cli'
      ? removeVueCliIntegration(target.content, operations)
      : removeWebpackIntegration(target.content, operations);
  return result.ok;
}

function legacyStateHasOnlyReusedOwnership(state: IntegrationState): boolean {
  return state.nodes.every((node) => node.ownership === 'reused')
    && Object.values(state.configFileOwnership).every((ownership) => ownership === 'reused');
}

export function createIntegrationPlanUnlocked(
  options: CreateIntegrationPlanOptions,
  context: WorkspaceContext,
  runtime: ProjectRuntimePaths,
): IntegrationPlan {
  const answers = normalizedAnswers(options.answers);
  const profile = detectProject({ workspaceRoot: context.rootPath, answers });
  const diagnostics: ProjectDiagnostic[] = [...profile.diagnostics];
  validateAnswers(answers, diagnostics, profile);
  try {
    if (readPendingJournal(runtime, context.rootIdentity)) {
      diagnostic(diagnostics, 'RECOVERY_REQUIRED', '存在未完成事务，请先运行 doctor。');
      return buildPlan(profile, answers, diagnostics, []);
    }
  } catch (error) {
    diagnostic(
      diagnostics,
      error instanceof TransactionConflictError ? error.code : 'TRANSACTION_CONFLICT',
      'pending journal 无法安全读取，请运行 doctor。',
    );
    return buildPlan(profile, answers, diagnostics, []);
  }

  const edits: PlannedFileEdit[] = [];
  if (profile.blocked || diagnostics.some((item) => item.blocking)) {
    return buildPlan(profile, answers, diagnostics, edits);
  }
  const selectedConfig = selectConfig(profile);
  if (!selectedConfig) {
    diagnostic(diagnostics, 'CONFIG_NOT_UNIQUE', '未找到唯一可安全修改的构建配置。');
    return buildPlan(profile, answers, diagnostics, edits);
  }

  let configTarget: CapturedTarget;
  let stateTarget: CapturedTarget;
  try {
    configTarget = captureTarget(context, selectedConfig.path);
    stateTarget = captureTarget(context, INTEGRATION_STATE_PATH);
  } catch {
    diagnostic(diagnostics, 'PATH_REJECTED', '配置或状态文件路径不满足安全约束。');
    return buildPlan(profile, answers, diagnostics, edits);
  }
  const beforeConfig = configTarget.content ?? selectedConfig.initialContent;
  if (beforeConfig === undefined) {
    diagnostic(diagnostics, 'CONFIG_NOT_FOUND', '构建配置文件不存在。');
    return buildPlan(profile, answers, diagnostics, edits);
  }
  const existingState = existingStateForPlan(stateTarget, diagnostics);
  const legacyExistingState = existingState?.stateFile.fingerprint
    === legacyIntegrationStateFingerprint();
  if (diagnostics.some((item) => item.blocking)) {
    return buildPlan(profile, answers, diagnostics, edits);
  }
  if (existingState && legacyExistingState
    && !legacyStateHasOnlyReusedOwnership(existingState)) {
    diagnostic(
      diagnostics,
      'TRANSACTION_CONFLICT',
      'legacy integration state 包含不可信的 created ownership，不能自动迁移。',
    );
    return buildPlan(profile, answers, diagnostics, edits);
  }
  if (existingState
    && !existingStateMatchesProfile(
      existingState,
      profile,
      selectedConfig.path,
      selectedConfig.moduleKind,
    )) {
    diagnostic(diagnostics, 'TRANSACTION_CONFLICT', 'integration state 与当前项目检测结果不一致。');
    return buildPlan(profile, answers, diagnostics, edits);
  }
  if (existingState && !validateRecordedConfig(existingState, configTarget)) {
    diagnostic(diagnostics, 'TRANSACTION_CONFLICT', '当前配置不再包含 integration state 记录的完整节点。');
    return buildPlan(profile, answers, diagnostics, edits);
  }

  const transformed = transformConfig(
    profile,
    selectedConfig.moduleKind,
    beforeConfig,
    answers,
  );
  if (!transformed.ok) {
    diagnostic(
      diagnostics,
      transformed.errorCode ?? 'CONFIG_SHAPE_UNSUPPORTED',
      '构建配置不在可证明安全的 AST 白名单内。',
    );
    return buildPlan(profile, answers, diagnostics, edits);
  }
  let operations;
  try {
    // existingState 已在上方通过当前 AST 的精确 fingerprint 预校验后才允许受控迁移。
    operations = preserveRecordedOwnership(
      selectedConfig.path,
      transformed.operations,
      existingState,
      { browserAccess: browserAccessAnswer(answers) },
    );
  } catch {
    diagnostic(diagnostics, 'TRANSACTION_CONFLICT', '配置节点与 integration state fingerprint 不一致。');
    return buildPlan(profile, answers, diagnostics, edits);
  }
  if (transformed.code !== beforeConfig || !configTarget.identity.exists) {
    edits.push(planEdit(configTarget, transformed.code, operations));
  }

  const desiredState = createIntegrationState(profile, [{
    path: selectedConfig.path,
    moduleKind: selectedConfig.moduleKind,
    fileOwnership: configTarget.identity.exists ? 'reused' : 'created',
    baseDigest: configTarget.digest,
    operations,
  }]);
  if (existingState) {
    desiredState.stateFile.ownership = legacyExistingState
      ? 'reused'
      : existingState.stateFile.ownership;
    desiredState.configFileOwnership = existingState.configFileOwnership;
    desiredState.configFileBaseDigests = existingState.configFileBaseDigests;
  }
  desiredState.stateFile.fingerprint = integrationStateFingerprint(desiredState);
  const serializedState = serializeIntegrationState(desiredState);
  if (serializedState !== stateTarget.content) {
    edits.push(planEdit(stateTarget, serializedState, [{
      kind: 'state-file',
      ownership: desiredState.stateFile.ownership,
      fingerprint: desiredState.stateFile.fingerprint,
      description: `${stateTarget.identity.exists ? '更新' : '创建'} .web-source-inspector.json 所有权状态。`,
    }]));
  }
  return buildPlan(profile, answers, diagnostics, edits);
}

export function createIntegrationPlan(
  options: CreateIntegrationPlanOptions,
): IntegrationPlan {
  const context = resolveWorkspaceContext(options.workspaceRoot);
  try {
    return withProjectLock(context, (runtime) =>
      createIntegrationPlanUnlocked(options, context, runtime));
  } catch (error) {
    if (!(error instanceof ProjectLockError)) {
      throw error;
    }
    const answers = normalizedAnswers(options.answers);
    const profile = detectProject({ workspaceRoot: context.rootPath, answers });
    const diagnostics = [...profile.diagnostics];
    diagnostic(diagnostics, error.code, error.message);
    return buildPlan(profile, answers, diagnostics, []);
  }
}
