import { resolveWorkspaceContext } from '../filesystem/identity';
import {
  executeTransaction,
  readPendingJournal,
  TransactionConflictError,
} from '../transaction/journal';
import { ProjectLockError, withProjectLock } from '../transaction/runtime';
import type { ProjectDiagnostic } from '../types';
import { createIntegrationPlanUnlocked } from './integration';
import type {
  ApplyIntegrationPlanOptions,
  IntegrationMutationResult,
} from './types';

function failure(
  errorCode: NonNullable<IntegrationMutationResult['errorCode']>,
  message: string,
  diagnostics: ProjectDiagnostic[] = [],
): IntegrationMutationResult {
  return {
    ok: false,
    operation: 'init-apply',
    changedFiles: [],
    diagnostics: [
      ...diagnostics,
      { code: errorCode, severity: 'error', message, blocking: true },
    ],
    errorCode,
  };
}

export function applyIntegrationPlan(
  options: ApplyIntegrationPlanOptions,
): IntegrationMutationResult {
  let context;
  try {
    context = resolveWorkspaceContext(options.workspaceRoot);
  } catch {
    return failure('INTERNAL_ERROR', 'workspace 路径无法安全解析。');
  }
  try {
    return withProjectLock(context, (runtime) => {
      try {
        if (readPendingJournal(runtime, context.rootIdentity)) {
          return failure('RECOVERY_REQUIRED', '存在未完成事务，请先运行 doctor。');
        }
      } catch (error) {
        return failure(
          'TRANSACTION_CONFLICT',
          error instanceof Error ? error.message : 'pending journal 冲突。',
        );
      }
      const plan = createIntegrationPlanUnlocked(options, context, runtime);
      const providedAnswers = options.answers ?? {};
      if (plan.requiredInputs.some((input) =>
        !Object.prototype.hasOwnProperty.call(providedAnswers, input.questionId))) {
        return failure(
          'PLAN_CONTEXT_REQUIRED',
          'apply 必须回传 plan 的 normalizedAnswers。',
          plan.diagnostics,
        );
      }
      if (plan.blocked) {
        const recoveryRequired = plan.diagnostics.some(
          (item) => item.code === 'RECOVERY_REQUIRED',
        );
        return failure(
          recoveryRequired ? 'RECOVERY_REQUIRED' : 'PLAN_STALE',
          '当前项目无法应用已确认计划，请重新预览。',
          plan.diagnostics,
        );
      }
      if (plan.planDigest !== options.planDigest) {
        return failure('PLAN_STALE', '项目或计划上下文已变化，请重新预览。');
      }
      if (plan.noOp) {
        return {
          ok: true,
          operation: 'init-apply',
          changedFiles: [],
          diagnostics: plan.diagnostics,
        };
      }
      try {
        const changedFiles = executeTransaction(
          context,
          runtime,
          'init-apply',
          plan.edits,
        );
        return {
          ok: true,
          operation: 'init-apply',
          changedFiles,
          diagnostics: plan.diagnostics,
        };
      } catch (error) {
        if (error instanceof TransactionConflictError) {
          let pending = false;
          try {
            pending = readPendingJournal(runtime, context.rootIdentity) !== null;
          } catch {
            pending = true;
          }
          return failure(
            pending ? 'TRANSACTION_CONFLICT' : 'PLAN_STALE',
            error.message,
          );
        }
        return failure('INTERNAL_ERROR', '初始化事务执行失败。');
      }
    });
  } catch (error) {
    return error instanceof ProjectLockError
      ? failure(error.code, error.message)
      : failure('INTERNAL_ERROR', '初始化 apply 发生内部错误。');
  }
}
