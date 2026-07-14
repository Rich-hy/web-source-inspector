import * as vscode from 'vscode';

import { runProjectCli } from './projectCli';

export interface IntegrationQuestion {
  questionId: string;
  type: 'choice' | 'origin';
  message: string;
  choices?: string[];
}

export interface IntegrationDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  blocking: boolean;
}

export interface IntegrationFileEdit {
  path: string;
  beforeDigest: string;
  afterDigest: string;
  beforeContent: string;
  afterContent: string | null;
}

export type IntegrationBundler = 'vite' | 'webpack' | 'vue-cli' | 'ambiguous' | 'unsupported';

export interface IntegrationPlanProfile {
  bundler: IntegrationBundler;
}

export interface IntegrationPlanResult {
  profile: IntegrationPlanProfile | null;
  normalizedAnswers: Record<string, string>;
  requiredInputs?: IntegrationQuestion[];
  diagnostics: IntegrationDiagnostic[];
  edits: IntegrationFileEdit[];
  planDigest: string;
  blocked: boolean;
  noOp: boolean;
}

export interface ResolvedIntegrationPlan {
  plan: IntegrationPlanResult;
  answers: Record<string, string>;
  envelopeOk: boolean;
  errorCode: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return value === 'ABSENT' || (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value));
}

function isDiagnostic(value: unknown): value is IntegrationDiagnostic {
  return isRecord(value)
    && typeof value.code === 'string'
    && /^[A-Z0-9_:-]{1,128}$/u.test(value.code)
    && (value.severity === 'info' || value.severity === 'warning' || value.severity === 'error')
    && typeof value.message === 'string'
    && typeof value.blocking === 'boolean';
}

function isQuestion(value: unknown): value is IntegrationQuestion {
  return isRecord(value)
    && typeof value.questionId === 'string'
    && /^[A-Za-z0-9._:-]{1,128}$/u.test(value.questionId)
    && (value.type === 'choice' || value.type === 'origin')
    && typeof value.message === 'string'
    && (value.choices === undefined
      || (Array.isArray(value.choices) && value.choices.every((choice) => typeof choice === 'string')));
}

function isFileEdit(value: unknown): value is IntegrationFileEdit {
  return isRecord(value)
    && typeof value.path === 'string'
    && isDigest(value.beforeDigest)
    && isDigest(value.afterDigest)
    && typeof value.beforeContent === 'string'
    && (typeof value.afterContent === 'string' || value.afterContent === null);
}

function isPlanProfile(value: unknown): value is IntegrationPlanProfile {
  return isRecord(value)
    && ['vite', 'webpack', 'vue-cli', 'ambiguous', 'unsupported'].includes(
      String(value.bundler),
    );
}

function parsePlanResult(
  value: unknown,
  operation: 'init' | 'remove',
): IntegrationPlanResult {
  const expectedOperation = `${operation}-plan`;
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.operation !== expectedOperation
    || typeof value.planDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(value.planDigest)
    || typeof value.blocked !== 'boolean'
    || typeof value.noOp !== 'boolean'
    || !Array.isArray(value.edits)
    || !value.edits.every(isFileEdit)
    || !Array.isArray(value.diagnostics)
    || !value.diagnostics.every(isDiagnostic)
    || (operation === 'init'
      ? !isPlanProfile(value.profile)
      : value.profile !== null && !isPlanProfile(value.profile))
    || !isRecord(value.normalizedAnswers)
    || !Object.entries(value.normalizedAnswers).every(([key, answer]) =>
      /^[A-Za-z0-9._:-]{1,128}$/u.test(key) && typeof answer === 'string')
    || (value.requiredInputs !== undefined
      && (!Array.isArray(value.requiredInputs) || !value.requiredInputs.every(isQuestion)))) {
    throw new Error('CLI_PLAN_INVALID');
  }
  return value as unknown as IntegrationPlanResult;
}

function answerArguments(answers: Readonly<Record<string, string>>): string[] {
  return Object.entries(answers)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([questionId, value]) => ['--answer', `${questionId}=${value}`]);
}

async function askQuestion(question: IntegrationQuestion): Promise<string | undefined> {
  if (question.type === 'choice' && question.choices?.length) {
    return vscode.window.showQuickPick(question.choices, { placeHolder: question.message });
  }
  if (question.type === 'origin') {
    return vscode.window.showInputBox({
      prompt: question.message,
      placeHolder: 'http://127.0.0.1:8080',
      validateInput(value) {
        try {
          const url = new URL(value);
          return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
            ? undefined
            : '请输入不带路径的精确 HTTP(S) Origin。';
        } catch {
          return '请输入有效的 HTTP(S) Origin。';
        }
      },
    });
  }
  throw new Error('CLI_QUESTION_UNSUPPORTED');
}

export async function resolveIntegrationPlan(
  projectRoot: string,
  operation: 'init' | 'remove',
  initialAnswers: Readonly<Record<string, string>> = {},
  trustedWorkspaceRoots: readonly string[] = [projectRoot],
): Promise<ResolvedIntegrationPlan | undefined> {
  const answers = { ...initialAnswers };
  for (let round = 0; round < 8; round += 1) {
    const result = await runProjectCli<IntegrationPlanResult>(projectRoot, [
      operation,
      '--json',
      '--phase',
      'plan',
      ...answerArguments(answers),
    ], trustedWorkspaceRoots);
    if (result.envelope.result === null) {
      throw new Error(result.envelope.errorCode ?? 'CLI_PLAN_INVALID');
    }
    const plan = parsePlanResult(result.envelope.result, operation);
    if (result.envelope.ok === plan.blocked
      || (plan.requiredInputs?.length && result.envelope.errorCode !== 'PLAN_CONTEXT_REQUIRED')) {
      throw new Error('CLI_PLAN_ENVELOPE_MISMATCH');
    }
    const unanswered = (plan.requiredInputs ?? []).filter((question) => answers[question.questionId] === undefined);
    if (unanswered.length === 0) {
      return {
        plan,
        answers: { ...plan.normalizedAnswers },
        envelopeOk: result.envelope.ok,
        errorCode: result.envelope.errorCode,
      };
    }
    for (const question of unanswered) {
      const answer = await askQuestion(question);
      if (answer === undefined) {
        return undefined;
      }
      answers[question.questionId] = answer;
    }
  }
  throw new Error('CLI_QUESTION_LIMIT');
}

function safePlanPath(value: string): boolean {
  return value.length > 0
    && value.length <= 1024
    && !value.includes('\\')
    && !value.startsWith('/')
    && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

/** 使用 VS Code 原生 diff 展示 CLI 已绑定 digest 的内容，diff 本身不参与 apply 授权。 */
export async function showIntegrationPlanDiff(
  folder: vscode.WorkspaceFolder,
  plan: IntegrationPlanResult,
  projectLabel = folder.name,
): Promise<void> {
  for (const edit of plan.edits) {
    if (!safePlanPath(edit.path) || typeof edit.beforeContent !== 'string'
      || (edit.afterContent !== null && typeof edit.afterContent !== 'string')) {
      throw new Error('CLI_PLAN_EDIT_INVALID');
    }
    const beforeDocument = await vscode.workspace.openTextDocument({
      language: edit.path.endsWith('.json') ? 'json' : 'typescript',
      content: edit.beforeContent,
    });
    const afterDocument = await vscode.workspace.openTextDocument({
      language: edit.path.endsWith('.json') ? 'json' : 'typescript',
      content: edit.afterContent ?? '',
    });
    await vscode.commands.executeCommand(
      'vscode.diff',
      beforeDocument.uri,
      afterDocument.uri,
      `Source Inspector: ${projectLabel}/${edit.path}`,
      { preview: false },
    );
  }
}

export function planDiagnosticsText(plan: IntegrationPlanResult): string {
  return plan.diagnostics.map((item) => `[${item.code}] ${item.message}`).join('\n');
}

export function toAnswerArguments(answers: Readonly<Record<string, string>>): string[] {
  return answerArguments(answers);
}
