import { spawn } from 'node:child_process';
import { realpath, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  PROTOCOL_LIMITS,
  parseCliJsonEnvelope,
  type CliJsonEnvelope,
  type CliJsonOperation,
  type ProtocolErrorCode,
} from '@web-source-inspector/protocol';

const CLI_TIMEOUT_MS = 30_000;

export type ProjectCliResolutionCode =
  | 'PACKAGE_NOT_INSTALLED'
  | 'PACKAGE_INVALID'
  | 'PACKAGE_OUTSIDE_WORKSPACE'
  | 'CLI_NOT_FOUND';

export class ProjectCliResolutionError extends Error {
  public constructor(public readonly code: ProjectCliResolutionCode) {
    super(code);
    this.name = 'ProjectCliResolutionError';
  }
}

export interface ProjectCliLocation {
  packageRoot: string;
  cliPath: string;
  version: string;
}

export interface ProjectCliResult<TResult = unknown> {
  envelope: CliJsonEnvelope<TResult>;
  exitCode: number;
  stderr: string;
}

interface ProjectCliDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  blocking: boolean;
}

export interface ProjectMutationResult {
  ok: boolean;
  operation: 'init-apply' | 'remove-apply';
  changedFiles: string[];
  diagnostics: ProjectCliDiagnostic[];
  errorCode?: string;
}

export interface ProjectDoctorResult {
  ok: boolean;
  operation: 'doctor';
  recovered: boolean;
  configured: boolean;
  diagnostics: ProjectCliDiagnostic[];
  errorCode?: string;
}

interface PublicPackageManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
}

const MUTATION_ERROR_CODES = new Set([
  'PLAN_CONTEXT_REQUIRED',
  'PLAN_STALE',
  'RECOVERY_REQUIRED',
  'TRANSACTION_CONFLICT',
  'PROJECT_LOCKED',
  'INTERNAL_ERROR',
]);

const DOCTOR_ERROR_CODES = new Set([
  'TRANSACTION_CONFLICT',
  'PROJECT_LOCKED',
  'INTERNAL_ERROR',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProjectDiagnostic(value: unknown): value is ProjectCliDiagnostic {
  return isRecord(value)
    && typeof value.code === 'string'
    && /^[A-Z0-9_:-]{1,128}$/u.test(value.code)
    && (value.severity === 'info' || value.severity === 'warning' || value.severity === 'error')
    && typeof value.message === 'string'
    && typeof value.blocking === 'boolean';
}

function isCanonicalRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= PROTOCOL_LIMITS.relativePathLength
    && !value.includes('\\')
    && !value.startsWith('/')
    && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function normalizedBusinessErrorCode(value: string): ProtocolErrorCode | undefined {
  switch (value) {
    case 'PROJECT_LOCKED':
      return 'TRANSACTION_CONFLICT';
    case 'PLAN_CONTEXT_REQUIRED':
    case 'PLAN_STALE':
    case 'RECOVERY_REQUIRED':
    case 'TRANSACTION_CONFLICT':
    case 'INTERNAL_ERROR':
      return value;
    default:
      return undefined;
  }
}

function validateBusinessDiagnostics(
  value: unknown,
  envelope: CliJsonEnvelope,
): value is ProjectCliDiagnostic[] {
  if (!Array.isArray(value)
    || value.length > PROTOCOL_LIMITS.diagnosticCount
    || !value.every(isProjectDiagnostic)
    || value.length !== envelope.diagnostics.length) {
    return false;
  }
  return value.every((diagnostic, index) => {
    const envelopeDiagnostic = envelope.diagnostics[index];
    return envelopeDiagnostic !== undefined
      && diagnostic.code === envelopeDiagnostic.code
      && diagnostic.severity === envelopeDiagnostic.severity
      && diagnostic.message === envelopeDiagnostic.message;
  });
}

function validateBusinessOutcome(
  result: Record<string, unknown>,
  envelope: CliJsonEnvelope,
  allowedErrorCodes: ReadonlySet<string>,
): void {
  if (typeof result.ok !== 'boolean' || result.ok !== envelope.ok) {
    throw new Error('CLI_RESULT_OK_MISMATCH');
  }
  if (result.ok) {
    if (result.errorCode !== undefined || envelope.errorCode !== null) {
      throw new Error('CLI_RESULT_ERROR_CODE_MISMATCH');
    }
    return;
  }
  if (typeof result.errorCode !== 'string'
    || !allowedErrorCodes.has(result.errorCode)
    || normalizedBusinessErrorCode(result.errorCode) !== envelope.errorCode) {
    throw new Error('CLI_RESULT_ERROR_CODE_MISMATCH');
  }
}

function validateMutationResult(
  envelope: CliJsonEnvelope,
  operation: 'init:apply' | 'remove:apply',
): void {
  const result = envelope.result;
  const expectedOperation = operation === 'init:apply' ? 'init-apply' : 'remove-apply';
  if (!isRecord(result)
    || result.operation !== expectedOperation
    || !Array.isArray(result.changedFiles)
    || !result.changedFiles.every(isCanonicalRelativePath)
    || new Set(result.changedFiles).size !== result.changedFiles.length
    || !validateBusinessDiagnostics(result.diagnostics, envelope)) {
    throw new Error('CLI_RESULT_INVALID');
  }
  validateBusinessOutcome(result, envelope, MUTATION_ERROR_CODES);
}

function validateDoctorResult(envelope: CliJsonEnvelope): void {
  const result = envelope.result;
  if (!isRecord(result)
    || result.operation !== 'doctor'
    || typeof result.recovered !== 'boolean'
    || typeof result.configured !== 'boolean'
    || !validateBusinessDiagnostics(result.diagnostics, envelope)) {
    throw new Error('CLI_RESULT_INVALID');
  }
  validateBusinessOutcome(result, envelope, DOCTOR_ERROR_CODES);
}

function validateCliResult(envelope: CliJsonEnvelope, exitCode: number): void {
  if ((exitCode !== 0 && exitCode !== 1 && exitCode !== 2)
    || (exitCode === 0) !== envelope.ok
    || (exitCode === 0) !== (envelope.errorCode === null)) {
    throw new Error('CLI_EXIT_CODE_MISMATCH');
  }
  // CLI 自身异常时允许失败 envelope 不带业务 result，调用方仍保留稳定 errorCode。
  if (!envelope.ok && envelope.result === null) {
    return;
  }
  if (envelope.operation === 'init:apply' || envelope.operation === 'remove:apply') {
    validateMutationResult(envelope, envelope.operation);
  } else if (envelope.operation === 'doctor') {
    validateDoctorResult(envelope);
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function cliBin(manifest: PublicPackageManifest): string | undefined {
  if (typeof manifest.bin === 'string') {
    return manifest.bin;
  }
  if (typeof manifest.bin === 'object' && manifest.bin !== null && !Array.isArray(manifest.bin)) {
    const candidate = (manifest.bin as Record<string, unknown>)['web-source-inspector'];
    return typeof candidate === 'string' ? candidate : undefined;
  }
  return undefined;
}

async function parsePackageManifest(manifestPath: string): Promise<PublicPackageManifest> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('manifest is not an object');
    }
    return parsed as PublicPackageManifest;
  } catch {
    throw new ProjectCliResolutionError('PACKAGE_INVALID');
  }
}

/**
 * 只接受当前 workspace 内实际安装的公开包，避免加载全局包或 workspace 外代码。
 */
export async function resolveProjectCli(
  projectRoot: string,
  trustedWorkspaceRoots: readonly string[] = [projectRoot],
): Promise<ProjectCliLocation> {
  const canonicalProjectRoot = await realpath(projectRoot);
  const canonicalTrustedRoots = await Promise.all(trustedWorkspaceRoots.map((root) => realpath(root)));
  const projectRequire = createRequire(path.join(canonicalProjectRoot, 'package.json'));
  let manifestPath: string;
  try {
    manifestPath = projectRequire.resolve('web-source-inspector/package.json');
  } catch {
    throw new ProjectCliResolutionError('PACKAGE_NOT_INSTALLED');
  }

  const canonicalManifestPath = await realpath(manifestPath);
  if (!canonicalTrustedRoots.some((root) => isInside(root, canonicalManifestPath))) {
    throw new ProjectCliResolutionError('PACKAGE_OUTSIDE_WORKSPACE');
  }
  const manifest = await parsePackageManifest(canonicalManifestPath);
  if (manifest.name !== 'web-source-inspector' || typeof manifest.version !== 'string') {
    throw new ProjectCliResolutionError('PACKAGE_INVALID');
  }
  const relativeBin = cliBin(manifest);
  if (!relativeBin || path.isAbsolute(relativeBin)) {
    throw new ProjectCliResolutionError('PACKAGE_INVALID');
  }

  const packageRoot = path.dirname(canonicalManifestPath);
  const lexicalCliPath = path.resolve(packageRoot, relativeBin);
  if (!isInside(packageRoot, lexicalCliPath)) {
    throw new ProjectCliResolutionError('PACKAGE_INVALID');
  }
  let canonicalCliPath: string;
  try {
    canonicalCliPath = await realpath(lexicalCliPath);
    const fileStat = await stat(canonicalCliPath);
    if (!fileStat.isFile() || !isInside(packageRoot, canonicalCliPath)) {
      throw new Error('CLI target is not a package file');
    }
  } catch {
    throw new ProjectCliResolutionError('CLI_NOT_FOUND');
  }
  return { packageRoot, cliPath: canonicalCliPath, version: manifest.version };
}

function expectedOperation(args: readonly string[]): CliJsonOperation | undefined {
  const command = args[0];
  if (command === 'doctor') {
    return 'doctor';
  }
  const phaseIndex = args.indexOf('--phase');
  const phase = phaseIndex >= 0 ? args[phaseIndex + 1] : undefined;
  if ((command === 'init' || command === 'remove') && (phase === 'plan' || phase === 'apply')) {
    return `${command}:${phase}`;
  }
  return undefined;
}

export async function runProjectCli<TResult = unknown>(
  projectRoot: string,
  args: readonly string[],
  trustedWorkspaceRoots: readonly string[] = [projectRoot],
): Promise<ProjectCliResult<TResult>> {
  const location = await resolveProjectCli(projectRoot, trustedWorkspaceRoots);
  const operation = expectedOperation(args);
  if (!operation) {
    throw new Error('INVALID_CLI_OPERATION');
  }

  return new Promise<ProjectCliResult<TResult>>((resolve, reject) => {
    const child = spawn(process.execPath, [location.cliPath, ...args], {
      cwd: projectRoot,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const collect = (chunks: Buffer[], maximumBytes: number) => (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const currentBytes = chunks === stdoutChunks ? stdoutBytes : stderrBytes;
      if (currentBytes + buffer.byteLength > maximumBytes) {
        fail(new Error('CLI_OUTPUT_TOO_LARGE'));
        return;
      }
      chunks.push(buffer);
      if (chunks === stdoutChunks) {
        stdoutBytes += buffer.byteLength;
      } else {
        stderrBytes += buffer.byteLength;
      }
    };

    child.stdout.on('data', collect(stdoutChunks, PROTOCOL_LIMITS.cliJsonBytes));
    child.stderr.on('data', collect(stderrChunks, PROTOCOL_LIMITS.cliJsonBytes));
    child.once('error', fail);
    child.once('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const serialized = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const parsed = parseCliJsonEnvelope(serialized);
      if (!parsed.ok || parsed.value.operation !== operation) {
        reject(new Error(parsed.ok ? 'CLI_OPERATION_MISMATCH' : parsed.error.code));
        return;
      }
      if (exitCode === null) {
        reject(new Error('CLI_PROCESS_TERMINATED'));
        return;
      }
      try {
        validateCliResult(parsed.value, exitCode);
      } catch (error) {
        reject(error);
        return;
      }
      resolve({
        envelope: parsed.value as CliJsonEnvelope<TResult>,
        exitCode,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    const timer = setTimeout(() => fail(new Error('CLI_TIMEOUT')), CLI_TIMEOUT_MS);
    timer.unref?.();
  });
}
