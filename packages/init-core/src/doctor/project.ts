import { detectProject } from '../detect/project';
import { captureTarget, resolveWorkspaceContext } from '../filesystem/identity';
import { createRemovalPlanUnlocked } from '../plan/removal';
import type { DoctorProjectOptions, DoctorResult } from '../plan/types';
import { readIntegrationState } from '../state/io';
import { INTEGRATION_STATE_PATH, type IntegrationState } from '../state/types';
import {
  recoverPendingTransaction,
  TransactionConflictError,
} from '../transaction/journal';
import { ProjectLockError, withProjectLock } from '../transaction/runtime';
import type { ProjectDiagnostic } from '../types';

function problem(
  code: string,
  message: string,
): ProjectDiagnostic {
  return { code, message, severity: 'error', blocking: true };
}

function answersFromState(state: IntegrationState | undefined): Record<string, string> {
  if (!state) {
    return {};
  }
  const answers: Record<string, string> = {};
  if (state.profile.bundler === 'vite'
    || state.profile.bundler === 'webpack'
    || state.profile.bundler === 'vue-cli') {
    answers.bundler = state.profile.bundler;
  }
  if (state.profile.bundler !== 'webpack') {
    return answers;
  }
  const rawPlugin = state.nodes.find((node) =>
    node.details?.browserTransport === 'raw');
  if (rawPlugin) {
    answers.transport = 'raw-watch';
    const origin = rawPlugin.details?.allowedOrigin;
    if (typeof origin === 'string') {
      answers.allowedOrigin = origin;
    }
    return answers;
  }
  if (state.nodes.some((node) => node.kind === 'transport-hook')) {
    answers.transport = 'wds';
  }
  return answers;
}

function compatibilityErrorCode(
  requiredInputCount: number,
  diagnostics: readonly ProjectDiagnostic[],
): 'PLAN_CONTEXT_REQUIRED' | 'TARGET_UNSUPPORTED' | undefined {
  if (requiredInputCount > 0) {
    return 'PLAN_CONTEXT_REQUIRED';
  }
  return diagnostics.some((item) => item.blocking)
    ? 'TARGET_UNSUPPORTED'
    : undefined;
}

export function doctorProject(options: DoctorProjectOptions): DoctorResult {
  let context;
  try {
    context = resolveWorkspaceContext(options.workspaceRoot);
  } catch {
    return {
      ok: false,
      recovered: false,
      configured: false,
      diagnostics: [problem('PATH_REJECTED', 'workspace 路径无法安全解析。')],
      errorCode: 'INTERNAL_ERROR',
    };
  }
  try {
    return withProjectLock(context, (runtime) => {
      let recovered = false;
      try {
        recovered = recoverPendingTransaction(context, runtime);
      } catch (error) {
        return {
          ok: false,
          recovered: false,
          configured: false,
          diagnostics: [problem(
            'TRANSACTION_CONFLICT',
            error instanceof Error ? error.message : '事务无法自动恢复。',
          )],
          errorCode: 'TRANSACTION_CONFLICT',
        };
      }

      const stateTarget = captureTarget(context, INTEGRATION_STATE_PATH);
      let state: IntegrationState | undefined;
      if (stateTarget.identity.exists) {
        try {
          state = readIntegrationState(stateTarget) ?? undefined;
        } catch (error) {
          return {
            ok: false,
            recovered,
            configured: true,
            diagnostics: [problem(
              'TRANSACTION_CONFLICT',
              error instanceof Error ? error.message : 'integration state 无效。',
            )],
            errorCode: 'TRANSACTION_CONFLICT',
          };
        }
      }

      let profile;
      try {
        profile = detectProject({
          workspaceRoot: context.rootPath,
          answers: answersFromState(state),
        });
      } catch {
        return {
          ok: false,
          recovered,
          configured: Boolean(state),
          diagnostics: [problem('INTERNAL_ERROR', '当前项目工具链无法安全检测。')],
          errorCode: 'INTERNAL_ERROR',
        };
      }

      const diagnostics = [...profile.diagnostics];
      if (state) {
        // 卸载所有权只依赖历史 state，不受当前工具链兼容性结果阻断。
        const removalPlan = createRemovalPlanUnlocked(options, context, runtime);
        diagnostics.push(...removalPlan.diagnostics);
        if (removalPlan.blocked) {
          return {
            ok: false,
            recovered,
            configured: true,
            diagnostics,
            errorCode: 'TRANSACTION_CONFLICT',
          };
        }
      }

      const compatibilityError = compatibilityErrorCode(
        profile.requiredInputs.length,
        profile.diagnostics,
      );
      if (compatibilityError) {
        return {
          ok: false,
          recovered,
          configured: Boolean(state),
          diagnostics,
          errorCode: compatibilityError,
        };
      }
      return {
        ok: true,
        recovered,
        configured: Boolean(state),
        diagnostics,
      };
    });
  } catch (error) {
    const locked = error instanceof ProjectLockError;
    const conflict = error instanceof TransactionConflictError;
    return {
      ok: false,
      recovered: false,
      configured: false,
      diagnostics: [problem(
        locked ? error.code : conflict ? error.code : 'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'doctor 发生内部错误。',
      )],
      errorCode: locked
        ? 'PROJECT_LOCKED'
        : conflict
          ? 'TRANSACTION_CONFLICT'
          : 'INTERNAL_ERROR',
    };
  }
}
