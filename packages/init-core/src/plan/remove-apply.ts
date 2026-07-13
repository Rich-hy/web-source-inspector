import { resolveWorkspaceContext } from '../filesystem/identity';
import {
  executeTransaction,
  readPendingJournal,
  TransactionConflictError,
} from '../transaction/journal';
import { ProjectLockError, withProjectLock } from '../transaction/runtime';
import type { ProjectDiagnostic } from '../types';
import { createRemovalPlanUnlocked } from './removal';
import type {
  ApplyRemovalPlanOptions,
  IntegrationMutationResult,
} from './types';

function failure(
  errorCode: NonNullable<IntegrationMutationResult['errorCode']>,
  message: string,
  diagnostics: ProjectDiagnostic[] = [],
): IntegrationMutationResult {
  return {
    ok: false,
    operation: 'remove-apply',
    changedFiles: [],
    diagnostics: [
      ...diagnostics,
      { code: errorCode, severity: 'error', message, blocking: true },
    ],
    errorCode,
  };
}

export function applyRemovalPlan(
  options: ApplyRemovalPlanOptions,
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
      const plan = createRemovalPlanUnlocked(options, context, runtime);
      if (plan.blocked || plan.planDigest !== options.planDigest) {
        return failure('PLAN_STALE', 'remove 计划已变化，请重新预览。', plan.diagnostics);
      }
      if (plan.noOp) {
        return {
          ok: true,
          operation: 'remove-apply',
          changedFiles: [],
          diagnostics: plan.diagnostics,
        };
      }
      try {
        const changedFiles = executeTransaction(
          context,
          runtime,
          'remove-apply',
          plan.edits,
        );
        return {
          ok: true,
          operation: 'remove-apply',
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
        return failure('INTERNAL_ERROR', 'remove 事务执行失败。');
      }
    });
  } catch (error) {
    return error instanceof ProjectLockError
      ? failure(error.code, error.message)
      : failure('INTERNAL_ERROR', 'remove apply 发生内部错误。');
  }
}
