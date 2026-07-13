import { createInterface } from 'node:readline';

import {
  applyIntegrationPlan,
  applyRemovalPlan,
  createIntegrationPlan,
  createRemovalPlan,
  doctorProject,
  type IntegrationPlan,
  type ProjectDiagnostic,
  type RemovalPlan,
} from '@web-source-inspector/init-core';
import {
  CLI_JSON_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  type CliJsonDiagnostic,
  type CliJsonEnvelope,
  type CliJsonOperation,
  type ProtocolErrorCode,
} from '@web-source-inspector/protocol';

type Command = 'init' | 'remove' | 'doctor';
type Phase = 'plan' | 'apply';

interface ParsedArguments {
  command: Command;
  json: boolean;
  phase?: Phase;
  planDigest?: string;
  answers: Record<string, string>;
}

interface CommandResult {
  envelope: CliJsonEnvelope;
  exitCode: number;
}

const KNOWN_ANSWERS = new Set(['bundler', 'allowedOrigin']);
const MAXIMUM_INTERACTIVE_PLAN_ROUNDS = 8;

function parseArguments(args: readonly string[]): ParsedArguments {
  const command = args[0];
  if (command !== 'init' && command !== 'remove' && command !== 'doctor') {
    throw new Error('INVALID_COMMAND');
  }
  let json = false;
  let phase: Phase | undefined;
  let planDigest: string | undefined;
  const answers: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--phase') {
      const value = args[index + 1];
      if (value !== 'plan' && value !== 'apply') {
        throw new Error('INVALID_PHASE');
      }
      phase = value;
      index += 1;
      continue;
    }
    if (argument === '--plan-digest') {
      const value = args[index + 1];
      if (!value || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
        throw new Error('INVALID_PLAN_DIGEST');
      }
      planDigest = value;
      index += 1;
      continue;
    }
    if (argument === '--answer') {
      const value = args[index + 1];
      const separator = value?.indexOf('=') ?? -1;
      const questionId = separator > 0 ? value?.slice(0, separator) : undefined;
      const answer = separator > 0 ? value?.slice(separator + 1) : undefined;
      if (!questionId || answer === undefined || !KNOWN_ANSWERS.has(questionId)
        || answer.length === 0 || answer.length > 2048 || /[\u0000-\u001f\u007f]/u.test(answer)
        || answers[questionId] !== undefined) {
        throw new Error('INVALID_ANSWER');
      }
      answers[questionId] = answer;
      index += 1;
      continue;
    }
    throw new Error('UNKNOWN_ARGUMENT');
  }
  if (command === 'doctor' && (phase || planDigest || Object.keys(answers).length > 0)) {
    throw new Error('INVALID_DOCTOR_ARGUMENT');
  }
  if (command === 'remove' && Object.keys(answers).length > 0) {
    throw new Error('INVALID_REMOVE_ANSWER');
  }
  if (json && command !== 'doctor' && !phase) {
    throw new Error('PHASE_REQUIRED');
  }
  if (!json && (phase || planDigest)) {
    throw new Error('JSON_PHASE_REQUIRED');
  }
  if (phase === 'apply' && !planDigest) {
    throw new Error('PLAN_DIGEST_REQUIRED');
  }
  if (phase !== 'apply' && planDigest) {
    throw new Error('UNEXPECTED_PLAN_DIGEST');
  }
  return {
    command,
    json,
    ...(phase ? { phase } : {}),
    ...(planDigest ? { planDigest } : {}),
    answers,
  };
}

function operationFor(argumentsValue: ParsedArguments): CliJsonOperation {
  if (argumentsValue.command === 'doctor') {
    return 'doctor';
  }
  return `${argumentsValue.command}:${argumentsValue.phase ?? 'plan'}`;
}

function cliDiagnostics(diagnostics: readonly ProjectDiagnostic[]): CliJsonDiagnostic[] {
  return diagnostics.map(({ code, severity, message }) => ({ code, severity, message }));
}

function envelope<TResult>(
  operation: CliJsonOperation,
  ok: boolean,
  result: TResult | null,
  diagnostics: CliJsonDiagnostic[],
  errorCode: ProtocolErrorCode | null,
): CliJsonEnvelope<TResult> {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    operation,
    ok,
    result,
    diagnostics,
    errorCode,
  };
}

function planErrorCode(plan: IntegrationPlan | RemovalPlan): ProtocolErrorCode | null {
  if (!plan.blocked) {
    return null;
  }
  if ('requiredInputs' in plan && plan.requiredInputs.length > 0) {
    return 'PLAN_CONTEXT_REQUIRED';
  }
  const stableCode = plan.diagnostics.find((item) => item.blocking)?.code;
  if (stableCode === 'RECOVERY_REQUIRED') {
    return 'RECOVERY_REQUIRED';
  }
  if (stableCode === 'TRANSACTION_CONFLICT') {
    return 'TRANSACTION_CONFLICT';
  }
  if (stableCode === 'MULTI_COMPILER_UNSUPPORTED') {
    return 'MULTI_COMPILER_UNSUPPORTED';
  }
  if (stableCode === 'WDS_TRANSPORT_UNSUPPORTED') {
    return 'WDS_TRANSPORT_UNSUPPORTED';
  }
  return 'TARGET_UNSUPPORTED';
}

function mutationErrorCode(value: string | undefined): ProtocolErrorCode {
  switch (value) {
    case 'PLAN_CONTEXT_REQUIRED':
    case 'PLAN_STALE':
    case 'RECOVERY_REQUIRED':
    case 'TRANSACTION_CONFLICT':
      return value;
    case 'PROJECT_LOCKED':
      return 'TRANSACTION_CONFLICT';
    default:
      return 'INTERNAL_ERROR';
  }
}

function mutationExitCode(ok: boolean, errorCode: string | undefined): number {
  return ok ? 0 : errorCode === 'INTERNAL_ERROR' ? 1 : 2;
}

async function runJson(argumentsValue: ParsedArguments): Promise<CommandResult> {
  const workspaceRoot = process.cwd();
  const operation = operationFor(argumentsValue);
  if (argumentsValue.command === 'doctor') {
    const doctorResult = await Promise.resolve(doctorProject({ workspaceRoot }));
    const result = { ...doctorResult, operation: 'doctor' as const };
    return {
      envelope: envelope(
        operation,
        result.ok,
        result,
        cliDiagnostics(result.diagnostics),
        result.ok ? null : mutationErrorCode(result.errorCode),
      ),
      exitCode: mutationExitCode(result.ok, result.errorCode),
    };
  }
  if (argumentsValue.command === 'init' && argumentsValue.phase === 'plan') {
    const result = createIntegrationPlan({ workspaceRoot, answers: argumentsValue.answers });
    const errorCode = planErrorCode(result);
    return {
      envelope: envelope(operation, !result.blocked, result, cliDiagnostics(result.diagnostics), errorCode),
      exitCode: result.blocked ? 2 : 0,
    };
  }
  if (argumentsValue.command === 'remove' && argumentsValue.phase === 'plan') {
    const result = createRemovalPlan({ workspaceRoot });
    const errorCode = planErrorCode(result);
    return {
      envelope: envelope(operation, !result.blocked, result, cliDiagnostics(result.diagnostics), errorCode),
      exitCode: result.blocked ? 2 : 0,
    };
  }
  if (argumentsValue.command === 'init') {
    const result = await Promise.resolve(applyIntegrationPlan({
      workspaceRoot,
      planDigest: argumentsValue.planDigest ?? '',
      answers: argumentsValue.answers,
    }));
    return {
      envelope: envelope(
        operation,
        result.ok,
        result,
        cliDiagnostics(result.diagnostics),
        result.ok ? null : mutationErrorCode(result.errorCode),
      ),
      exitCode: mutationExitCode(result.ok, result.errorCode),
    };
  }
  const result = await Promise.resolve(applyRemovalPlan({
    workspaceRoot,
    planDigest: argumentsValue.planDigest ?? '',
  }));
  return {
    envelope: envelope(
      operation,
      result.ok,
      result,
      cliDiagnostics(result.diagnostics),
      result.ok ? null : mutationErrorCode(result.errorCode),
    ),
    exitCode: mutationExitCode(result.ok, result.errorCode),
  };
}

function ask(query: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    input.question(query, (answer) => {
      input.close();
      resolve(answer.trim());
    });
  });
}

async function completeRequiredAnswers(plan: IntegrationPlan, answers: Record<string, string>): Promise<boolean> {
  const askedQuestionIds = new Set<string>();
  for (const question of plan.requiredInputs) {
    if (askedQuestionIds.has(question.questionId)) {
      continue;
    }
    askedQuestionIds.add(question.questionId);
    const choices = question.choices?.length ? ` (${question.choices.join('/')})` : '';
    const answer = await ask(`${question.message}${choices}: `);
    if (!answer) {
      return false;
    }
    answers[question.questionId] = answer;
  }
  return true;
}

function answerFingerprint(answers: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(answers).sort(([left], [right]) => left.localeCompare(right)));
}

async function resolveInteractiveIntegrationPlan(
  workspaceRoot: string,
  answers: Record<string, string>,
): Promise<IntegrationPlan | undefined> {
  for (let round = 0; round < MAXIMUM_INTERACTIVE_PLAN_ROUNDS; round += 1) {
    const plan = createIntegrationPlan({ workspaceRoot, answers });
    if (plan.requiredInputs.length === 0) {
      return plan;
    }
    const beforeAnswers = answerFingerprint(answers);
    if (!(await completeRequiredAnswers(plan, answers))) {
      return undefined;
    }
    if (answerFingerprint(answers) === beforeAnswers) {
      process.stderr.write('Source Inspector could not make progress while collecting required inputs.\n');
      return undefined;
    }
  }
  process.stderr.write('Source Inspector exceeded the required input round limit.\n');
  return undefined;
}

function printPlan(plan: IntegrationPlan | RemovalPlan): void {
  for (const diagnostic of plan.diagnostics) {
    process.stdout.write(`[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}\n`);
  }
  for (const edit of plan.edits) {
    process.stdout.write(`\n--- ${edit.path}\n${edit.beforeContent}\n`);
    process.stdout.write(`+++ ${edit.path}\n${edit.afterContent ?? '<DELETE>'}\n`);
  }
}

async function runInteractive(argumentsValue: ParsedArguments): Promise<number> {
  const workspaceRoot = process.cwd();
  if (argumentsValue.command === 'doctor') {
    const result = await Promise.resolve(doctorProject({ workspaceRoot }));
    for (const diagnostic of result.diagnostics) {
      process.stdout.write(`[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}\n`);
    }
    process.stdout.write(result.ok ? 'Source Inspector doctor completed.\n' : 'Source Inspector doctor found blocking issues.\n');
    return mutationExitCode(result.ok, result.errorCode);
  }

  if (argumentsValue.command === 'init') {
    const plan = await resolveInteractiveIntegrationPlan(workspaceRoot, argumentsValue.answers);
    if (!plan) {
      return 2;
    }
    printPlan(plan);
    if (plan.blocked) {
      return 2;
    }
    if (plan.noOp) {
      process.stdout.write('Source Inspector is already enabled.\n');
      return 0;
    }
    if (!/^y(?:es)?$/iu.test(await ask('Apply this integration plan? [y/N] '))) {
      return 0;
    }
    const result = await Promise.resolve(applyIntegrationPlan({
      workspaceRoot,
      planDigest: plan.planDigest,
      answers: plan.normalizedAnswers,
    }));
    process.stdout.write(result.ok ? 'Source Inspector enabled.\n' : `Enable failed: ${result.errorCode ?? 'INTERNAL_ERROR'}\n`);
    return mutationExitCode(result.ok, result.errorCode);
  }

  const plan = createRemovalPlan({ workspaceRoot });
  printPlan(plan);
  if (plan.blocked) {
    return 2;
  }
  if (plan.noOp) {
    process.stdout.write('Source Inspector is not enabled.\n');
    return 0;
  }
  if (!/^y(?:es)?$/iu.test(await ask('Apply this removal plan? [y/N] '))) {
    return 0;
  }
  const result = await Promise.resolve(applyRemovalPlan({ workspaceRoot, planDigest: plan.planDigest }));
  process.stdout.write(result.ok ? 'Source Inspector disabled.\n' : `Disable failed: ${result.errorCode ?? 'INTERNAL_ERROR'}\n`);
  return mutationExitCode(result.ok, result.errorCode);
}

function inferFailureOperation(args: readonly string[]): CliJsonOperation {
  const command = args[0];
  const phaseIndex = args.indexOf('--phase');
  const phase = phaseIndex >= 0 ? args[phaseIndex + 1] : undefined;
  if ((command === 'init' || command === 'remove') && (phase === 'plan' || phase === 'apply')) {
    return `${command}:${phase}`;
  }
  return command === 'remove' ? 'remove:plan' : command === 'init' ? 'init:plan' : 'doctor';
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  let argumentsValue: ParsedArguments;
  try {
    argumentsValue = parseArguments(rawArguments);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INVALID_ARGUMENT';
    if (rawArguments.includes('--json')) {
      const protocolError: ProtocolErrorCode = code === 'PLAN_DIGEST_REQUIRED'
        ? 'PLAN_CONTEXT_REQUIRED'
        : 'INVALID_MESSAGE';
      const failure = envelope(
        inferFailureOperation(rawArguments),
        false,
        null,
        [{ code, severity: 'error', message: 'CLI 参数无效。' }],
        protocolError,
      );
      process.stdout.write(`${JSON.stringify(failure)}\n`);
    } else {
      process.stderr.write('Usage: web-source-inspector <init|remove|doctor> [--json --phase <plan|apply>]\n');
    }
    process.exitCode = 1;
    return;
  }

  try {
    if (argumentsValue.json) {
      const result = await runJson(argumentsValue);
      process.stdout.write(`${JSON.stringify(result.envelope)}\n`);
      process.exitCode = result.exitCode;
    } else {
      process.exitCode = await runInteractive(argumentsValue);
    }
  } catch {
    if (argumentsValue.json) {
      const failure = envelope(
        operationFor(argumentsValue),
        false,
        null,
        [{ code: 'INTERNAL_ERROR', severity: 'error', message: 'CLI 执行失败。' }],
        'INTERNAL_ERROR',
      );
      process.stdout.write(`${JSON.stringify(failure)}\n`);
    } else {
      process.stderr.write('Source Inspector failed with INTERNAL_ERROR.\n');
    }
    process.exitCode = 1;
  }
}

void main();
