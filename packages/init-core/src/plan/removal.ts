import { removeViteIntegration } from '../ast/vite';
import { removeVueCliIntegration, removeWebpackIntegration } from '../ast/webpack';
import { digestCanonical, sha256 } from '../digest';
import { detectProject } from '../detect/project';
import {
  captureTarget,
  resolveWorkspaceContext,
  type WorkspaceContext,
} from '../filesystem/identity';
import { IntegrationStateError, readIntegrationState } from '../state/io';
import {
  INTEGRATION_STATE_PATH,
} from '../state/types';
import { readPendingJournal, TransactionConflictError } from '../transaction/journal';
import {
  ProjectLockError,
  withProjectLock,
  type ProjectRuntimePaths,
} from '../transaction/runtime';
import type { ProjectDiagnostic, ProjectProfile } from '../types';
import type {
  AstOperation,
  CreateRemovalPlanOptions,
  PlannedFileEdit,
  RemovalPlan,
} from './types';

function addDiagnostic(
  diagnostics: ProjectDiagnostic[],
  code: string,
  message: string,
): void {
  diagnostics.push({ code, message, severity: 'error', blocking: true });
}

function digestInput(
  profile: ProjectProfile | null,
  diagnostics: readonly ProjectDiagnostic[],
  edits: readonly PlannedFileEdit[],
): unknown {
  return {
    operation: 'remove-plan',
    schemaVersion: 1,
    profile,
    normalizedAnswers: {},
    diagnostics,
    edits: edits.map(({ beforeContent: _before, afterContent: _after, ...edit }) => edit),
  };
}

function buildRemovalPlan(
  profile: ProjectProfile | null,
  diagnostics: ProjectDiagnostic[],
  edits: PlannedFileEdit[],
): RemovalPlan {
  const blocked = diagnostics.some((item) => item.blocking);
  return {
    schemaVersion: 1,
    operation: 'remove-plan',
    profile,
    normalizedAnswers: {},
    diagnostics,
    edits,
    planDigest: digestCanonical(digestInput(profile, diagnostics, edits)),
    blocked,
    noOp: !blocked && edits.length === 0,
  };
}

function tryDetectProfile(context: WorkspaceContext): ProjectProfile | null {
  try {
    return detectProject({ workspaceRoot: context.rootPath });
  } catch {
    return null;
  }
}

export function createRemovalPlanUnlocked(
  _options: CreateRemovalPlanOptions,
  context: WorkspaceContext,
  runtime: ProjectRuntimePaths,
): RemovalPlan {
  const profile = tryDetectProfile(context);
  const diagnostics: ProjectDiagnostic[] = [];
  const edits: PlannedFileEdit[] = [];
  try {
    if (readPendingJournal(runtime, context.rootIdentity)) {
      addDiagnostic(diagnostics, 'RECOVERY_REQUIRED', '存在未完成事务，请先运行 doctor。');
      return buildRemovalPlan(profile, diagnostics, edits);
    }
  } catch (error) {
    addDiagnostic(
      diagnostics,
      error instanceof TransactionConflictError ? error.code : 'TRANSACTION_CONFLICT',
      'pending journal 无法安全读取。',
    );
    return buildRemovalPlan(profile, diagnostics, edits);
  }

  const stateTarget = captureTarget(context, INTEGRATION_STATE_PATH);
  if (!stateTarget.identity.exists) {
    return buildRemovalPlan(profile, diagnostics, edits);
  }
  let state;
  try {
    state = readIntegrationState(stateTarget);
  } catch (error) {
    addDiagnostic(
      diagnostics,
      error instanceof IntegrationStateError ? error.code : 'TRANSACTION_CONFLICT',
      'integration state 无法安全解析。',
    );
    return buildRemovalPlan(profile, diagnostics, edits);
  }
  if (!state) {
    return buildRemovalPlan(profile, diagnostics, edits);
  }

  for (const configPath of state.configFiles) {
    const target = captureTarget(context, configPath);
    if (!target.identity.exists || target.content === null) {
      addDiagnostic(diagnostics, 'TRANSACTION_CONFLICT', `配置 ${configPath} 不存在。`);
      continue;
    }
    const operations: AstOperation[] = state.nodes
      .filter((node) => node.configPath === configPath)
      .map((node) => ({
        kind: node.kind,
        ownership: node.ownership,
        fingerprint: node.fingerprint,
        description: `移除计划校验 ${node.kind} 节点。`,
        ...(node.details ? { details: node.details } : {}),
      }));
    const transformed = state.profile.bundler === 'vite'
      ? removeViteIntegration(target.content, operations)
      : state.profile.bundler === 'vue-cli'
        ? removeVueCliIntegration(target.content, operations)
        : removeWebpackIntegration(target.content, operations);
    if (!transformed.ok) {
      addDiagnostic(
        diagnostics,
        transformed.errorCode ?? 'TRANSACTION_CONFLICT',
        `配置 ${configPath} 的所有权 fingerprint 已变化。`,
      );
      continue;
    }
    const deleteCreatedConfig = state.configFileOwnership[configPath] === 'created'
      && state.configFileBaseDigests[configPath] === 'ABSENT'
      && state.profile.bundler === 'vue-cli'
      && /^\s*module\.exports\s*=\s*\{\s*\}\s*;?\s*$/u.test(transformed.code);
    if (deleteCreatedConfig) {
      edits.push({
        path: configPath,
        target: target.identity,
        beforeDigest: target.digest,
        afterDigest: 'ABSENT',
        afterExists: false,
        beforeContent: target.content,
        afterContent: null,
        operations,
      });
      continue;
    }
    if (transformed.code !== target.content) {
      edits.push({
        path: configPath,
        target: target.identity,
        beforeDigest: target.digest,
        afterDigest: sha256(transformed.code),
        afterExists: true,
        beforeContent: target.content,
        afterContent: transformed.code,
        operations,
      });
    }
  }

  if (state.stateFile.ownership !== 'created') {
    addDiagnostic(
      diagnostics,
      'TRANSACTION_CONFLICT',
      '状态文件不属于初始化器，不能自动删除。',
    );
  } else {
    edits.push({
      path: INTEGRATION_STATE_PATH,
      target: stateTarget.identity,
      beforeDigest: stateTarget.digest,
      afterDigest: 'ABSENT',
      afterExists: false,
      beforeContent: stateTarget.content ?? '',
      afterContent: null,
      operations: [{
        kind: 'state-file',
        ownership: state.stateFile.ownership,
        fingerprint: state.stateFile.fingerprint,
        description: '删除初始化器拥有的 .web-source-inspector.json。',
      }],
    });
  }
  return buildRemovalPlan(profile, diagnostics, edits);
}

export function createRemovalPlan(options: CreateRemovalPlanOptions): RemovalPlan {
  const context = resolveWorkspaceContext(options.workspaceRoot);
  try {
    return withProjectLock(context, (runtime) =>
      createRemovalPlanUnlocked(options, context, runtime));
  } catch (error) {
    const diagnostics: ProjectDiagnostic[] = [];
    addDiagnostic(
      diagnostics,
      error instanceof ProjectLockError ? error.code : 'INTERNAL_ERROR',
      error instanceof Error ? error.message : 'remove plan 失败。',
    );
    return buildRemovalPlan(tryDetectProfile(context), diagnostics, []);
  }
}
