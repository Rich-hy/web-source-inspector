import { captureTarget, resolveWorkspaceContext } from '../filesystem/identity';
import { readIntegrationState } from '../state/io';
import { INTEGRATION_STATE_PATH } from '../state/types';
import {
  recoverPendingTransaction,
  TransactionConflictError,
} from '../transaction/journal';
import { ProjectLockError, withProjectLock } from '../transaction/runtime';
import type { ProjectDiagnostic } from '../types';
import { createRemovalPlanUnlocked } from '../plan/removal';
import type { DoctorProjectOptions, DoctorResult } from '../plan/types';

function problem(
  code: string,
  message: string,
): ProjectDiagnostic {
  return { code, message, severity: 'error', blocking: true };
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
      if (!stateTarget.identity.exists) {
        return {
          ok: true,
          recovered,
          configured: false,
          diagnostics: [],
        };
      }
      try {
        readIntegrationState(stateTarget);
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
      const removalPlan = createRemovalPlanUnlocked(options, context, runtime);
      if (removalPlan.blocked) {
        return {
          ok: false,
          recovered,
          configured: true,
          diagnostics: removalPlan.diagnostics,
          errorCode: 'TRANSACTION_CONFLICT',
        };
      }
      return {
        ok: true,
        recovered,
        configured: true,
        diagnostics: [],
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
