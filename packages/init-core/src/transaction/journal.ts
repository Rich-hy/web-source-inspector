import {
  closeSync,
  constants,
  existsSync,
  fchownSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../digest';
import {
  captureTarget,
  fileIdentity,
  normalizeRelativeTarget,
  sameFileIdentity,
  sameTargetIdentity,
  type WorkspaceContext,
} from '../filesystem/identity';
import type { FileIdentity, PlannedFileEdit } from '../plan/types';
import {
  assertSecureRuntimeFile,
  assertSecureRuntimePaths,
  type ProjectRuntimePaths,
} from './runtime';

type JournalPhase =
  | 'prepared'
  | 'temp-registered'
  | 'temp-written'
  | 'rename-intent'
  | 'renamed'
  | 'rollback-prepared'
  | 'rollback-temp-registered'
  | 'rollback-temp-written'
  | 'rollback-rename-intent';

interface JournalEntry {
  path: string;
  tempPath: string;
  snapshotName?: string;
  snapshotDigest?: string;
  beforeDigest: string | 'ABSENT';
  afterDigest: string | 'ABSENT';
  beforeExists: boolean;
  afterExists: boolean;
  beforeIdentity?: FileIdentity;
  beforeMetadata?: FileMetadata;
  tempIdentity?: FileIdentity;
  afterIdentity?: FileIdentity;
  phase: JournalPhase;
}

interface FileMetadata {
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
}

export interface PendingJournal {
  schemaVersion: 1;
  transactionId: string;
  rootIdentity: string;
  operation: 'init-apply' | 'remove-apply';
  entries: JournalEntry[];
}

export class TransactionConflictError extends Error {
  readonly code = 'TRANSACTION_CONFLICT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TransactionConflictError';
  }
}

function validDigest(value: unknown, allowAbsent: boolean): value is string {
  return (allowAbsent && value === 'ABSENT')
    || (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value));
}

function validFileIdentity(value: unknown): value is FileIdentity {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const identity = value as Partial<FileIdentity>;
  return typeof identity.device === 'string'
    && typeof identity.inode === 'string'
    && typeof identity.birthtimeNs === 'string'
    && Number.isSafeInteger(identity.mode);
}

function validFileMetadata(value: unknown): value is FileMetadata {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const metadata = value as Partial<FileMetadata>;
  return Number.isSafeInteger(metadata.uid)
    && Number(metadata.uid) >= 0
    && Number.isSafeInteger(metadata.gid)
    && Number(metadata.gid) >= 0
    && typeof metadata.atimeMs === 'number'
    && Number.isFinite(metadata.atimeMs)
    && metadata.atimeMs >= 0
    && typeof metadata.mtimeMs === 'number'
    && Number.isFinite(metadata.mtimeMs)
    && metadata.mtimeMs >= 0;
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
}

function sameRenameIdentity(
  source: FileIdentity | undefined,
  target: FileIdentity | undefined,
): boolean {
  if (process.platform !== 'win32') {
    return sameFileIdentity(source, target);
  }
  // NTFS replace-existing 保留 source file index，但 birthtime 会继承旧 target。
  return Boolean(source && target
    && source.device !== '0'
    && source.inode !== '0'
    && source.device === target.device
    && source.inode === target.inode
    && source.mode === target.mode);
}

function samePhysicalFileIdentity(
  left: FileIdentity | undefined,
  right: FileIdentity | undefined,
): boolean {
  return Boolean(left && right
    && left.device === right.device
    && left.inode === right.inode
    && left.birthtimeNs === right.birthtimeNs);
}

function strongMetadataMatches(stats: Stats, metadata: FileMetadata | undefined): boolean {
  return !metadata || (stats.uid === metadata.uid
    && stats.gid === metadata.gid
    && Math.abs(stats.mtimeMs - metadata.mtimeMs) <= 2);
}

function writeAndFlush(
  filePath: string,
  content: string,
  options: {
    privateRuntimeFile?: boolean;
    mode?: number;
  } = {},
): FileIdentity {
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag();
  const descriptor = openSync(filePath, flags, options.mode ?? 0o600);
  let openedIdentity: FileIdentity;
  try {
    let openedStats = fstatSync(descriptor);
    if (!openedStats.isFile() || openedStats.nlink !== 1) {
      throw new TransactionConflictError('事务文件不是普通文件');
    }
    writeFileSync(descriptor, content, 'utf8');
    if (options.mode !== undefined) {
      fchmodSync(descriptor, options.mode & 0o7777);
    }
    fsyncSync(descriptor);
    openedStats = fstatSync(descriptor);
    if (!openedStats.isFile() || openedStats.nlink !== 1) {
      throw new TransactionConflictError('事务文件 identity 已变化');
    }
    openedIdentity = fileIdentity(openedStats);
  } finally {
    closeSync(descriptor);
  }
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink()
    || !stats.isFile()
    || stats.nlink !== 1
    || !sameFileIdentity(openedIdentity, fileIdentity(stats))) {
    throw new TransactionConflictError('事务文件不是普通文件');
  }
  if (options.privateRuntimeFile) {
    try {
      assertSecureRuntimeFile(filePath);
    } catch {
      throw new TransactionConflictError('事务 runtime 文件安全校验失败');
    }
  }
  return openedIdentity;
}

function registerWorkspaceTemp(
  filePath: string,
  mode: number,
  metadata: FileMetadata | undefined,
): FileIdentity {
  const descriptor = openSync(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
    mode & 0o7777,
  );
  let openedIdentity: FileIdentity;
  try {
    let openedStats = fstatSync(descriptor);
    if (!openedStats.isFile() || openedStats.nlink !== 1) {
      throw new TransactionConflictError('事务临时文件不是独占普通文件');
    }
    if (metadata && process.platform !== 'win32') {
      fchownSync(descriptor, metadata.uid, metadata.gid);
    }
    fchmodSync(descriptor, mode & 0o7777);
    fsyncSync(descriptor);
    openedStats = fstatSync(descriptor);
    if (!openedStats.isFile()
      || openedStats.nlink !== 1
      || (metadata && process.platform !== 'win32'
        && (openedStats.uid !== metadata.uid || openedStats.gid !== metadata.gid))) {
      throw new TransactionConflictError('事务临时文件 identity 已变化');
    }
    openedIdentity = fileIdentity(openedStats);
  } finally {
    closeSync(descriptor);
  }
  const finalStats = lstatSync(filePath);
  if (finalStats.isSymbolicLink()
    || !finalStats.isFile()
    || finalStats.nlink !== 1
    || !sameFileIdentity(openedIdentity, fileIdentity(finalStats))) {
    throw new TransactionConflictError('事务临时文件 identity 已变化');
  }
  return openedIdentity;
}

function applyRecordedMetadata(
  filePath: string,
  expectedIdentity: FileIdentity,
  mode: number,
  metadata: FileMetadata | undefined,
): FileIdentity {
  const descriptor = openSync(filePath, constants.O_WRONLY | noFollowFlag());
  let finalIdentity: FileIdentity;
  try {
    let stats = fstatSync(descriptor);
    if (!stats.isFile()
      || stats.nlink !== 1
      || !sameFileIdentity(fileIdentity(stats), expectedIdentity)) {
      throw new TransactionConflictError('恢复文件 metadata 时 identity 已变化');
    }
    if (metadata && process.platform !== 'win32') {
      fchownSync(descriptor, metadata.uid, metadata.gid);
    }
    // chown 可能清除 setuid/setgid，所以 POSIX mode 必须后恢复。
    if (process.platform !== 'win32') {
      fchmodSync(descriptor, mode & 0o7777);
    }
    if (metadata && process.platform !== 'win32') {
      futimesSync(
        descriptor,
        new Date(metadata.atimeMs),
        new Date(metadata.mtimeMs),
      );
    }
    fsyncSync(descriptor);
    stats = fstatSync(descriptor);
    finalIdentity = fileIdentity(stats);
    if (!stats.isFile()
      || stats.nlink !== 1
      || !samePhysicalFileIdentity(expectedIdentity, finalIdentity)
      || (process.platform !== 'win32'
        && (stats.mode & 0o7777) !== (mode & 0o7777))
      || !strongMetadataMatches(stats, metadata)) {
      throw new TransactionConflictError('文件 metadata 恢复校验失败');
    }
  } finally {
    closeSync(descriptor);
  }
  const pathStats = lstatSync(filePath);
  if (pathStats.isSymbolicLink()
    || !pathStats.isFile()
    || pathStats.nlink !== 1
    || !sameFileIdentity(fileIdentity(pathStats), finalIdentity)
    || !strongMetadataMatches(pathStats, metadata)) {
    throw new TransactionConflictError('文件 metadata 落盘后 identity 已变化');
  }
  return finalIdentity;
}

function capturePlannedBeforeMetadata(
  context: WorkspaceContext,
  edit: PlannedFileEdit,
): FileMetadata | undefined {
  if (process.platform === 'win32' || !edit.target.exists) {
    return undefined;
  }
  const current = captureTarget(context, edit.path);
  if (!sameTargetIdentity(current.identity, edit.target)
    || current.digest !== edit.beforeDigest) {
    throw new TransactionConflictError(`目标 ${edit.path} 在读取 metadata 时已变化`);
  }
  const descriptor = openSync(current.absolutePath, constants.O_RDONLY | noFollowFlag());
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()
      || stats.nlink !== 1
      || !sameFileIdentity(fileIdentity(stats), current.identity.fileIdentity)) {
      throw new TransactionConflictError(`目标 ${edit.path} metadata identity 已变化`);
    }
    return {
      uid: stats.uid,
      gid: stats.gid,
      atimeMs: stats.atimeMs,
      mtimeMs: stats.mtimeMs,
    };
  } finally {
    closeSync(descriptor);
  }
}

function writeRegisteredWorkspaceTemp(
  context: WorkspaceContext,
  entry: JournalEntry,
  content: string,
): void {
  const captured = captureTarget(context, entry.tempPath);
  if (!captured.identity.exists
    || !sameFileIdentity(captured.identity.fileIdentity, entry.tempIdentity)) {
    throw new TransactionConflictError(`临时文件 ${entry.tempPath} identity 冲突`);
  }
  const descriptor = openSync(captured.absolutePath, constants.O_WRONLY | noFollowFlag());
  try {
    const openedStats = fstatSync(descriptor);
    if (!openedStats.isFile()
      || openedStats.nlink !== 1
      || !sameFileIdentity(fileIdentity(openedStats), entry.tempIdentity)) {
      throw new TransactionConflictError(`临时文件 ${entry.tempPath} identity 已变化`);
    }
    // 校验句柄 identity 后再截断，避免在 open 阶段误伤未登记文件。
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    const writtenStats = fstatSync(descriptor);
    if (!writtenStats.isFile()
      || writtenStats.nlink !== 1
      || !sameFileIdentity(fileIdentity(writtenStats), entry.tempIdentity)) {
      throw new TransactionConflictError(`临时文件 ${entry.tempPath} 写入时 identity 已变化`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function readSecureRuntimeFile(filePath: string, maximumBytes: number): string {
  let beforeStats: Stats;
  try {
    beforeStats = assertSecureRuntimeFile(filePath);
  } catch {
    throw new TransactionConflictError('事务 runtime 文件安全校验失败');
  }
  if (beforeStats.size > maximumBytes) {
    throw new TransactionConflictError('事务 runtime 文件过大');
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | noFollowFlag());
  try {
    const openedStats = fstatSync(descriptor);
    if (!openedStats.isFile()
      || openedStats.nlink !== 1
      || !sameFileIdentity(fileIdentity(beforeStats), fileIdentity(openedStats))) {
      throw new TransactionConflictError('事务 runtime 文件 identity 已变化');
    }
    const content = readFileSync(descriptor, 'utf8');
    const afterStats = assertSecureRuntimeFile(filePath);
    if (!sameFileIdentity(fileIdentity(beforeStats), fileIdentity(afterStats))) {
      throw new TransactionConflictError('事务 runtime 文件 identity 已变化');
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function persistJournal(runtime: ProjectRuntimePaths, journal: PendingJournal): void {
  try {
    assertSecureRuntimePaths(runtime);
    if (existsSync(runtime.journalPath)) {
      assertSecureRuntimeFile(runtime.journalPath);
    }
  } catch {
    throw new TransactionConflictError('事务 runtime 路径不安全');
  }
  const serializedJournal = `${JSON.stringify(journal)}\n`;
  const temporaryPath = path.join(
    runtime.directory,
    `.journal-${journal.transactionId}-${randomBytes(6).toString('hex')}.tmp`,
  );
  const temporaryIdentity = writeAndFlush(temporaryPath, serializedJournal, {
    privateRuntimeFile: true,
  });
  renameSync(temporaryPath, runtime.journalPath);
  const persistedStats = assertSecureRuntimeFile(runtime.journalPath);
  if (!sameRenameIdentity(temporaryIdentity, fileIdentity(persistedStats))
    || readSecureRuntimeFile(runtime.journalPath, 4 * 1024 * 1024) !== serializedJournal) {
    throw new TransactionConflictError('pending journal 原子替换校验失败');
  }
}

function assertPlannedTarget(
  context: WorkspaceContext,
  edit: PlannedFileEdit,
): void {
  const current = captureTarget(context, edit.path);
  if (!sameTargetIdentity(current.identity, edit.target)
    || current.digest !== edit.beforeDigest) {
    throw new TransactionConflictError(`目标 ${edit.path} 已变化`);
  }
}

function snapshotPath(runtime: ProjectRuntimePaths, snapshotName: string): string {
  if (!/^[A-Za-z0-9_-]+\.snapshot$/u.test(snapshotName)) {
    throw new TransactionConflictError('snapshot 名称无效');
  }
  return path.join(runtime.snapshotsDirectory, snapshotName);
}

function createSnapshot(
  runtime: ProjectRuntimePaths,
  transactionId: string,
  index: number,
  content: string,
): { name: string; digest: string } {
  const name = `${transactionId}-${index}.snapshot`;
  const digest = sha256(content);
  writeAndFlush(snapshotPath(runtime, name), content, { privateRuntimeFile: true });
  return { name, digest };
}

function safeUnlinkRegisteredTemp(
  context: WorkspaceContext,
  entry: JournalEntry,
): void {
  const captured = captureTarget(context, entry.tempPath);
  if (!captured.identity.exists) {
    return;
  }
  if (!entry.tempIdentity
    || !sameFileIdentity(captured.identity.fileIdentity, entry.tempIdentity)) {
    throw new TransactionConflictError(`临时文件 ${entry.tempPath} identity 冲突`);
  }
  unlinkSync(captured.absolutePath);
}

function currentMatchesBeforeContent(
  context: WorkspaceContext,
  entry: JournalEntry,
): boolean {
  const current = captureTarget(context, entry.path);
  if (!entry.beforeExists) {
    return !current.identity.exists;
  }
  return current.identity.exists
    && current.digest === entry.beforeDigest;
}

function restoreBeforeMetadata(
  context: WorkspaceContext,
  entry: JournalEntry,
): void {
  if (!entry.beforeExists || !entry.beforeIdentity) {
    return;
  }
  const current = captureTarget(context, entry.path);
  if (!current.identity.exists || current.digest !== entry.beforeDigest
    || !current.identity.fileIdentity) {
    throw new TransactionConflictError(`目标 ${entry.path} 恢复 metadata 前已变化`);
  }
  const metadataOwnedByTransaction = sameFileIdentity(
    current.identity.fileIdentity,
    entry.beforeIdentity,
  ) || (entry.phase === 'rollback-rename-intent'
    && sameRenameIdentity(entry.tempIdentity, current.identity.fileIdentity));
  if (!metadataOwnedByTransaction) {
    return;
  }
  applyRecordedMetadata(
    current.absolutePath,
    current.identity.fileIdentity,
    entry.beforeIdentity.mode,
    entry.beforeMetadata,
  );
}

function currentMatchesAfter(
  context: WorkspaceContext,
  entry: JournalEntry,
): boolean {
  const current = captureTarget(context, entry.path);
  if (!entry.afterExists) {
    return !current.identity.exists;
  }
  const expectedAfterIdentity = entry.afterIdentity
    ?? (entry.phase === 'rename-intent' || entry.phase === 'renamed'
      ? entry.tempIdentity
      : undefined);
  return current.identity.exists
    && current.digest === entry.afterDigest
    && (entry.afterIdentity
      ? sameFileIdentity(current.identity.fileIdentity, expectedAfterIdentity)
      : sameRenameIdentity(expectedAfterIdentity, current.identity.fileIdentity));
}

function readSnapshotContent(
  runtime: ProjectRuntimePaths,
  entry: JournalEntry,
): string {
  if (!entry.snapshotName || !entry.snapshotDigest) {
    throw new TransactionConflictError(`目标 ${entry.path} 缺少恢复 snapshot`);
  }
  const sourceSnapshot = snapshotPath(runtime, entry.snapshotName);
  const beforeContent = readSecureRuntimeFile(sourceSnapshot, 64 * 1024 * 1024);
  if (sha256(beforeContent) !== entry.snapshotDigest
    || entry.snapshotDigest !== entry.beforeDigest) {
    throw new TransactionConflictError('snapshot digest 不匹配');
  }
  return beforeContent;
}

function registeredTempMatches(
  context: WorkspaceContext,
  entry: JournalEntry,
  expectedDigest: string,
): boolean {
  const temp = captureTarget(context, entry.tempPath);
  return temp.identity.exists
    && temp.digest === expectedDigest
    && sameFileIdentity(temp.identity.fileIdentity, entry.tempIdentity);
}

function registeredTempIdentityMatches(
  context: WorkspaceContext,
  entry: JournalEntry,
): boolean {
  const temp = captureTarget(context, entry.tempPath);
  return temp.identity.exists
    && sameFileIdentity(temp.identity.fileIdentity, entry.tempIdentity);
}

function restoreEntry(
  context: WorkspaceContext,
  runtime: ProjectRuntimePaths,
  journal: PendingJournal,
  entry: JournalEntry,
): void {
  const initialTemp = captureTarget(context, entry.tempPath);
  if (currentMatchesBeforeContent(context, entry)) {
    if (initialTemp.identity.exists) {
      if (!entry.tempIdentity) {
        throw new TransactionConflictError(`临时文件 ${entry.tempPath} 未登记 identity`);
      }
      safeUnlinkRegisteredTemp(context, entry);
    }
    restoreBeforeMetadata(context, entry);
    return;
  }
  if (![
    'rename-intent',
    'renamed',
    'rollback-prepared',
    'rollback-temp-registered',
    'rollback-temp-written',
    'rollback-rename-intent',
  ].includes(entry.phase)
    || !currentMatchesAfter(context, entry)) {
    throw new TransactionConflictError(`目标 ${entry.path} 无法安全恢复`);
  }
  const target = captureTarget(context, entry.path);
  if (!entry.beforeExists) {
    if (entry.phase !== 'rollback-rename-intent') {
      entry.afterIdentity = target.identity.fileIdentity;
      entry.tempIdentity = undefined;
      entry.phase = 'rollback-rename-intent';
      persistJournal(runtime, journal);
    }
    if (!currentMatchesAfter(context, entry)) {
      throw new TransactionConflictError(`目标 ${entry.path} 在删除回滚前已变化`);
    }
    unlinkSync(target.absolutePath);
    return;
  }
  const existingTemp = captureTarget(context, entry.tempPath);
  if (!entry.afterExists) {
    if (!registeredTempMatches(context, entry, entry.beforeDigest)) {
      throw new TransactionConflictError(`目标 ${entry.path} 的删除暂存文件冲突`);
    }
    if (entry.phase !== 'rollback-rename-intent') {
      entry.phase = 'rollback-rename-intent';
      persistJournal(runtime, journal);
    }
    if (!registeredTempMatches(context, entry, entry.beforeDigest)
      || !currentMatchesAfter(context, entry)) {
      throw new TransactionConflictError(`目标 ${entry.path} 在删除回滚前已变化`);
    }
    applyRecordedMetadata(
      existingTemp.absolutePath,
      entry.tempIdentity as FileIdentity,
      entry.beforeIdentity?.mode ?? 0o600,
      entry.beforeMetadata,
    );
    renameSync(existingTemp.absolutePath, target.absolutePath);
    if (!currentMatchesBeforeContent(context, entry)) {
      throw new TransactionConflictError(`目标 ${entry.path} 恢复校验失败`);
    }
    restoreBeforeMetadata(context, entry);
    return;
  }

  const beforeContent = readSnapshotContent(runtime, entry);
  if (entry.phase === 'rename-intent' || entry.phase === 'renamed') {
    // 先持久化 rollback intent，确保任一后续写入点再次崩溃仍可续跑。
    entry.afterIdentity = target.identity.fileIdentity;
    entry.tempIdentity = undefined;
    entry.phase = 'rollback-prepared';
    persistJournal(runtime, journal);
  }
  let rollbackTemp = captureTarget(context, entry.tempPath);
  if (entry.phase === 'rollback-prepared') {
    if (rollbackTemp.identity.exists) {
      throw new TransactionConflictError(`目标 ${entry.path} 的 rollback temp 未登记`);
    }
    entry.tempIdentity = registerWorkspaceTemp(
      rollbackTemp.absolutePath,
      entry.beforeIdentity?.mode ?? 0o600,
      entry.beforeMetadata,
    );
    entry.phase = 'rollback-temp-registered';
    persistJournal(runtime, journal);
    rollbackTemp = captureTarget(context, entry.tempPath);
  }
  if (entry.phase === 'rollback-temp-registered') {
    if (!registeredTempIdentityMatches(context, entry)
      || !currentMatchesAfter(context, entry)) {
      throw new TransactionConflictError(`目标 ${entry.path} 在 rollback 写入前已变化`);
    }
    writeRegisteredWorkspaceTemp(context, entry, beforeContent);
    if (!registeredTempMatches(context, entry, entry.beforeDigest)) {
      throw new TransactionConflictError(`目标 ${entry.path} 的 rollback temp 写入校验失败`);
    }
    entry.phase = 'rollback-temp-written';
    persistJournal(runtime, journal);
  }
  if (entry.phase === 'rollback-temp-written') {
    if (!registeredTempMatches(context, entry, entry.beforeDigest)
      || !currentMatchesAfter(context, entry)) {
      throw new TransactionConflictError(`目标 ${entry.path} 在 rollback intent 前变化`);
    }
    entry.phase = 'rollback-rename-intent';
    persistJournal(runtime, journal);
  }
  if (!registeredTempMatches(context, entry, entry.beforeDigest)
    || !currentMatchesAfter(context, entry)) {
    throw new TransactionConflictError(`目标 ${entry.path} 在恢复前变化`);
  }
  applyRecordedMetadata(
    rollbackTemp.absolutePath,
    entry.tempIdentity as FileIdentity,
    entry.beforeIdentity?.mode ?? 0o600,
    entry.beforeMetadata,
  );
  renameSync(rollbackTemp.absolutePath, target.absolutePath);
  if (!currentMatchesBeforeContent(context, entry)) {
    throw new TransactionConflictError(`目标 ${entry.path} 恢复校验失败`);
  }
  restoreBeforeMetadata(context, entry);
}

function cleanupTransactionFiles(
  context: WorkspaceContext,
  runtime: ProjectRuntimePaths,
  journal: PendingJournal,
): void {
  const snapshots: string[] = [];
  const temps: JournalEntry[] = [];
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index] as JournalEntry;
    if (typeof entry !== 'object' || entry === null
      || typeof entry.path !== 'string'
      || typeof entry.tempPath !== 'string'
      || typeof entry.phase !== 'string') {
      throw new TransactionConflictError('pending journal entry schema 无效');
    }
    if (entry.snapshotName) {
      const sourceSnapshot = snapshotPath(runtime, entry.snapshotName);
      if (existsSync(sourceSnapshot)) {
        const content = readSecureRuntimeFile(sourceSnapshot, 64 * 1024 * 1024);
        if (!entry.snapshotDigest || sha256(content) !== entry.snapshotDigest) {
          throw new TransactionConflictError('cleanup snapshot digest 不匹配');
        }
        snapshots.push(sourceSnapshot);
      }
    }
    const temp = captureTarget(context, entry.tempPath);
    if (temp.identity.exists) {
      if (!entry.tempIdentity
        || !sameFileIdentity(temp.identity.fileIdentity, entry.tempIdentity)) {
        throw new TransactionConflictError(`临时文件 ${entry.tempPath} identity 冲突`);
      }
      temps.push(entry);
    }
  }
  for (const entry of temps) {
    safeUnlinkRegisteredTemp(context, entry);
  }
  // journal 先于 snapshot 移除；崩溃时最多留下私有孤儿文件，不留下失效 journal。
  if (existsSync(runtime.journalPath)) {
    try {
      assertSecureRuntimeFile(runtime.journalPath);
    } catch {
      throw new TransactionConflictError('pending journal 安全校验失败');
    }
    unlinkSync(runtime.journalPath);
  }
  for (const sourceSnapshot of snapshots) {
    if (existsSync(sourceSnapshot)) {
      assertSecureRuntimeFile(sourceSnapshot);
      unlinkSync(sourceSnapshot);
    }
  }
}

export function readPendingJournal(
  runtime: ProjectRuntimePaths,
  expectedRootIdentity: string,
): PendingJournal | null {
  try {
    assertSecureRuntimePaths(runtime);
  } catch {
    throw new TransactionConflictError('事务 runtime 路径不安全');
  }
  if (!existsSync(runtime.journalPath)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(readSecureRuntimeFile(runtime.journalPath, 4 * 1024 * 1024));
  } catch {
    throw new TransactionConflictError('pending journal JSON 无效');
  }
  const journal = value as PendingJournal;
  if (
    typeof journal !== 'object'
    || journal === null
    || journal.schemaVersion !== 1
    || journal.rootIdentity !== expectedRootIdentity
    || !/^[a-f0-9]{32}$/u.test(journal.transactionId)
    || !['init-apply', 'remove-apply'].includes(journal.operation)
    || !Array.isArray(journal.entries)
    || journal.entries.length === 0
  ) {
    throw new TransactionConflictError('pending journal schema 或 root 无效');
  }
  const registeredPaths = new Set<string>();
  const registeredSnapshots = new Set<string>();
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index] as JournalEntry;
    if (typeof entry !== 'object' || entry === null
      || typeof entry.path !== 'string'
      || typeof entry.tempPath !== 'string'
      || typeof entry.phase !== 'string') {
      throw new TransactionConflictError('pending journal entry schema 无效');
    }
    normalizeRelativeTarget(entry.path);
    normalizeRelativeTarget(entry.tempPath);
    const targetDirectory = path.posix.dirname(entry.path);
    const expectedTempName = `.wsi-${journal.transactionId}-${index}.tmp`;
    const expectedTempPath = targetDirectory === '.'
      ? expectedTempName
      : `${targetDirectory}/${expectedTempName}`;
    const validSnapshot = entry.beforeExists
      ? entry.snapshotName === `${journal.transactionId}-${index}.snapshot`
        && validDigest(entry.snapshotDigest, false)
      : entry.snapshotName === undefined && entry.snapshotDigest === undefined;
    if (entry.tempPath !== expectedTempPath
      || ![
        'prepared',
        'temp-registered',
        'temp-written',
        'rename-intent',
        'renamed',
        'rollback-prepared',
        'rollback-temp-registered',
        'rollback-temp-written',
        'rollback-rename-intent',
      ].includes(entry.phase)
      || typeof entry.beforeExists !== 'boolean'
      || typeof entry.afterExists !== 'boolean'
      || !validDigest(entry.beforeDigest, !entry.beforeExists)
      || !validDigest(entry.afterDigest, !entry.afterExists)
      || (entry.beforeExists !== (entry.beforeDigest !== 'ABSENT'))
      || (entry.afterExists !== (entry.afterDigest !== 'ABSENT'))
      || (entry.beforeExists && !validFileIdentity(entry.beforeIdentity))
      || (!entry.beforeExists && entry.beforeIdentity !== undefined)
      || (entry.beforeExists && process.platform !== 'win32'
        && !validFileMetadata(entry.beforeMetadata))
      || ((!entry.beforeExists || process.platform === 'win32')
        && entry.beforeMetadata !== undefined)
      || !validSnapshot
      || (entry.tempIdentity !== undefined && !validFileIdentity(entry.tempIdentity))
      || (entry.afterIdentity !== undefined && !validFileIdentity(entry.afterIdentity))) {
      throw new TransactionConflictError('pending journal entry 无效');
    }
    if (registeredPaths.has(entry.path)
      || registeredPaths.has(entry.tempPath)
      || (entry.snapshotName !== undefined && registeredSnapshots.has(entry.snapshotName))) {
      throw new TransactionConflictError('pending journal 引用重复');
    }
    registeredPaths.add(entry.path);
    registeredPaths.add(entry.tempPath);
    if (entry.snapshotName) {
      registeredSnapshots.add(entry.snapshotName);
      const snapshotContent = readSecureRuntimeFile(
        snapshotPath(runtime, entry.snapshotName),
        64 * 1024 * 1024,
      );
      if (sha256(snapshotContent) !== entry.snapshotDigest) {
        throw new TransactionConflictError('pending journal snapshot 无效');
      }
    }
    const forwardTempPhase = entry.phase === 'temp-registered'
      || entry.phase === 'temp-written';
    const rollbackTempPhase = entry.phase === 'rollback-temp-registered'
      || entry.phase === 'rollback-temp-written';
    const validRenamedIdentity = entry.phase !== 'renamed'
      || (entry.tempIdentity
        && (entry.afterExists
          ? entry.afterIdentity
            && sameRenameIdentity(entry.tempIdentity, entry.afterIdentity)
          : entry.afterIdentity === undefined));
    const validRollbackIntent = entry.phase !== 'rollback-rename-intent'
      || (!entry.beforeExists
        ? entry.afterExists && entry.afterIdentity && !entry.tempIdentity
        : !entry.afterExists
          ? entry.tempIdentity && !entry.afterIdentity
          : entry.tempIdentity && entry.afterIdentity);
    if ((entry.phase === 'prepared' && (entry.tempIdentity || entry.afterIdentity))
      || (forwardTempPhase
        && (!entry.afterExists || !entry.tempIdentity || entry.afterIdentity))
      || (entry.phase === 'rename-intent' && (!entry.tempIdentity || entry.afterIdentity))
      || !validRenamedIdentity
      || (entry.phase === 'rollback-prepared'
        && (!entry.beforeExists || !entry.afterExists || !entry.afterIdentity || entry.tempIdentity))
      || (rollbackTempPhase
        && (!entry.beforeExists || !entry.afterExists
          || !entry.afterIdentity || !entry.tempIdentity))
      || !validRollbackIntent) {
      throw new TransactionConflictError('pending journal phase identity 无效');
    }
  }
  return journal;
}

export function recoverPendingTransaction(
  context: WorkspaceContext,
  runtime: ProjectRuntimePaths,
): boolean {
  const journal = readPendingJournal(runtime, context.rootIdentity);
  if (!journal) {
    return false;
  }
  for (const entry of [...journal.entries].reverse()) {
    restoreEntry(context, runtime, journal, entry);
  }
  cleanupTransactionFiles(context, runtime, journal);
  return true;
}

export function executeTransaction(
  context: WorkspaceContext,
  runtime: ProjectRuntimePaths,
  operation: PendingJournal['operation'],
  edits: readonly PlannedFileEdit[],
): string[] {
  if (readPendingJournal(runtime, context.rootIdentity)) {
    throw new TransactionConflictError('存在未恢复事务');
  }
  for (const edit of edits) {
    assertPlannedTarget(context, edit);
  }
  const transactionId = randomBytes(16).toString('hex');
  const journal: PendingJournal = {
    schemaVersion: 1,
    transactionId,
    rootIdentity: context.rootIdentity,
    operation,
    entries: [],
  };
  edits.forEach((edit, index) => {
    const targetDirectory = path.posix.dirname(edit.path);
    const tempName = `.wsi-${transactionId}-${index}.tmp`;
    const tempPath = targetDirectory === '.' ? tempName : `${targetDirectory}/${tempName}`;
    const snapshot = edit.target.exists
      ? createSnapshot(runtime, transactionId, index, edit.beforeContent)
      : undefined;
    const beforeMetadata = capturePlannedBeforeMetadata(context, edit);
    journal.entries.push({
      path: edit.path,
      tempPath,
      ...(snapshot ? { snapshotName: snapshot.name, snapshotDigest: snapshot.digest } : {}),
      beforeDigest: edit.beforeDigest,
      afterDigest: edit.afterDigest,
      beforeExists: edit.target.exists,
      afterExists: edit.afterExists,
      beforeIdentity: edit.target.fileIdentity,
      ...(beforeMetadata ? { beforeMetadata } : {}),
      phase: 'prepared',
    });
  });
  persistJournal(runtime, journal);

  try {
    edits.forEach((edit, index) => {
      const entry = journal.entries[index] as JournalEntry;
      assertPlannedTarget(context, edit);
      if (!edit.afterExists) {
        const current = captureTarget(context, edit.path);
        if (!current.identity.exists) {
          throw new TransactionConflictError(`待删除目标 ${edit.path} 不存在`);
        }
        const temp = captureTarget(context, entry.tempPath);
        if (temp.identity.exists || !current.identity.fileIdentity) {
          throw new TransactionConflictError(`删除暂存目标 ${entry.tempPath} 冲突`);
        }
        entry.tempIdentity = current.identity.fileIdentity;
        entry.phase = 'rename-intent';
        persistJournal(runtime, journal);
        assertPlannedTarget(context, edit);
        renameSync(current.absolutePath, temp.absolutePath);
        if (!registeredTempMatches(context, entry, edit.beforeDigest)) {
          throw new TransactionConflictError(`删除暂存目标 ${entry.tempPath} 校验失败`);
        }
        entry.phase = 'renamed';
        persistJournal(runtime, journal);
        return;
      }
      if (edit.afterContent === null || edit.afterDigest === 'ABSENT') {
        throw new TransactionConflictError(`目标 ${edit.path} 缺少 afterContent`);
      }
      const temp = captureTarget(context, entry.tempPath);
      if (temp.identity.exists) {
        throw new TransactionConflictError(`临时目标 ${entry.tempPath} 已存在`);
      }
      const current = captureTarget(context, edit.path);
      entry.tempIdentity = registerWorkspaceTemp(
        temp.absolutePath,
        current.identity.fileIdentity?.mode ?? 0o600,
        entry.beforeMetadata,
      );
      entry.phase = 'temp-registered';
      persistJournal(runtime, journal);
      writeRegisteredWorkspaceTemp(context, entry, edit.afterContent);
      const writtenTemp = captureTarget(context, entry.tempPath);
      if (writtenTemp.digest !== edit.afterDigest
        || !sameFileIdentity(writtenTemp.identity.fileIdentity, entry.tempIdentity)) {
        throw new TransactionConflictError(`临时目标 ${entry.tempPath} 校验失败`);
      }
      entry.phase = 'temp-written';
      persistJournal(runtime, journal);
      entry.phase = 'rename-intent';
      persistJournal(runtime, journal);
      assertPlannedTarget(context, edit);
      entry.tempIdentity = applyRecordedMetadata(
        writtenTemp.absolutePath,
        entry.tempIdentity,
        current.identity.fileIdentity?.mode ?? 0o600,
        entry.beforeMetadata,
      );
      renameSync(writtenTemp.absolutePath, captureTarget(context, edit.path).absolutePath);
      const afterTarget = captureTarget(context, edit.path);
      if (afterTarget.digest !== edit.afterDigest
        || !sameRenameIdentity(entry.tempIdentity, afterTarget.identity.fileIdentity)) {
        throw new TransactionConflictError(`目标 ${edit.path} 写入后校验失败`);
      }
      entry.afterIdentity = applyRecordedMetadata(
        afterTarget.absolutePath,
        afterTarget.identity.fileIdentity as FileIdentity,
        current.identity.fileIdentity?.mode ?? 0o600,
        entry.beforeMetadata,
      );
      entry.phase = 'renamed';
      persistJournal(runtime, journal);
    });
  } catch (error) {
    try {
      for (const entry of [...journal.entries].reverse()) {
        restoreEntry(context, runtime, journal, entry);
      }
      cleanupTransactionFiles(context, runtime, journal);
    } catch (rollbackError) {
      throw rollbackError instanceof TransactionConflictError
        ? rollbackError
        : new TransactionConflictError('事务失败且自动回滚未完成');
    }
    throw error;
  }
  cleanupTransactionFiles(context, runtime, journal);
  return edits.map((edit) => edit.path);
}
