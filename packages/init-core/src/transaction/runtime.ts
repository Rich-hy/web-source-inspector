import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileIdentity, sameFileIdentity, type WorkspaceContext } from '../filesystem/identity';

export class ProjectLockError extends Error {
  readonly code = 'PROJECT_LOCKED' as const;

  constructor() {
    super('项目初始化锁已存在或无法安全回收');
    this.name = 'ProjectLockError';
  }
}

export interface ProjectRuntimePaths {
  directory: string;
  lockPath: string;
  journalPath: string;
  snapshotsDirectory: string;
}

interface LockRecord {
  schemaVersion: 1;
  rootIdentity: string;
  pid: number;
  createdAt: number;
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function assertPrivateOwnerAndMode(stats: Stats, expectedMode: number): void {
  if (process.platform === 'win32') {
    // Node Stats 无法证明 Windows owner/DACL；依赖用户 profile temp 默认 ACL。
    return;
  }
  if (typeof process.getuid !== 'function'
    || stats.uid !== process.getuid()
    || (stats.mode & 0o7777) !== expectedMode) {
    throw new Error('初始化 runtime owner 或权限不安全');
  }
}

function ensurePrivateDirectory(directory: string): void {
  // 逐层创建并复核，避免 recursive mkdir 静默穿过预置的链接目录。
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const stats = lstatSync(directory);
  const canonical = realpathSync.native(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()
    || comparablePath(canonical) !== comparablePath(path.resolve(directory))) {
    throw new Error('初始化 runtime 路径不是普通目录');
  }
  assertPrivateOwnerAndMode(stats, 0o700);
}

export function assertSecureRuntimeFile(filePath: string): Stats {
  const stats = lstatSync(filePath) as Stats;
  const canonical = realpathSync.native(filePath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1
    || comparablePath(canonical) !== comparablePath(path.resolve(filePath))) {
    throw new Error('初始化 runtime 文件类型、链接数或规范路径不安全');
  }
  assertPrivateOwnerAndMode(stats, 0o600);
  return stats;
}

export function assertSecureRuntimePaths(runtime: ProjectRuntimePaths): void {
  ensurePrivateDirectory(runtime.directory);
  ensurePrivateDirectory(runtime.snapshotsDirectory);
  if (path.dirname(runtime.snapshotsDirectory) !== runtime.directory
    || path.dirname(runtime.lockPath) !== runtime.directory
    || path.dirname(runtime.journalPath) !== runtime.directory) {
    throw new Error('初始化 runtime 路径关系无效');
  }
}

export function projectRuntimePaths(context: WorkspaceContext): ProjectRuntimePaths {
  const key = context.rootIdentity.slice('sha256:'.length);
  const tempRoot = realpathSync.native(path.resolve(os.tmpdir()));
  const tempStats = lstatSync(tempRoot);
  if (tempStats.isSymbolicLink() || !tempStats.isDirectory()) {
    throw new Error('系统临时目录不是普通目录');
  }
  const applicationDirectory = path.join(tempRoot, 'web-source-inspector');
  ensurePrivateDirectory(applicationDirectory);
  const initDirectory = path.join(applicationDirectory, 'init');
  ensurePrivateDirectory(initDirectory);
  const directory = path.join(initDirectory, key);
  ensurePrivateDirectory(directory);
  const snapshotsDirectory = path.join(directory, 'snapshots');
  ensurePrivateDirectory(snapshotsDirectory);
  const runtime = {
    directory,
    lockPath: path.join(directory, 'project.lock'),
    journalPath: path.join(directory, 'pending-journal.json'),
    snapshotsDirectory,
  };
  assertSecureRuntimePaths(runtime);
  return runtime;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeStaleLock(lockPath: string, rootIdentity: string): boolean {
  let beforeStats: Stats;
  try {
    beforeStats = assertSecureRuntimeFile(lockPath);
  } catch {
    return false;
  }
  if (beforeStats.size > 4096) {
    throw new ProjectLockError();
  }
  let parsed: LockRecord;
  let descriptor: number | undefined;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(lockPath, constants.O_RDONLY | noFollow);
    const openedStats = fstatSync(descriptor);
    assertPrivateOwnerAndMode(openedStats, 0o600);
    if (!openedStats.isFile()
      || openedStats.nlink !== 1
      || !sameFileIdentity(fileIdentity(beforeStats), fileIdentity(openedStats))) {
      throw new ProjectLockError();
    }
    parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as LockRecord;
  } catch {
    throw new ProjectLockError();
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || parsed.schemaVersion !== 1
    || parsed.rootIdentity !== rootIdentity
    || !/^sha256:[a-f0-9]{64}$/u.test(parsed.rootIdentity)
    || !Number.isSafeInteger(parsed.pid)
    || parsed.pid < 1
    || !Number.isSafeInteger(parsed.createdAt)
    || parsed.createdAt < 1
    || processIsAlive(parsed.pid)
  ) {
    throw new ProjectLockError();
  }
  const afterStats = assertSecureRuntimeFile(lockPath);
  if (!sameFileIdentity(fileIdentity(beforeStats), fileIdentity(afterStats))) {
    throw new ProjectLockError();
  }
  unlinkSync(lockPath);
  return true;
}

export function withProjectLock<T>(
  context: WorkspaceContext,
  callback: (runtime: ProjectRuntimePaths) => T,
): T {
  const runtime = projectRuntimePaths(context);
  let descriptor: number;
  try {
    descriptor = openSync(
      runtime.lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
      || !removeStaleLock(runtime.lockPath, context.rootIdentity)) {
      throw new ProjectLockError();
    }
    descriptor = openSync(
      runtime.lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
  }
  let createdStats: Stats;
  try {
    createdStats = assertSecureRuntimeFile(runtime.lockPath);
    const openedStats = fstatSync(descriptor);
    if (!openedStats.isFile()
      || openedStats.nlink !== 1
      || !sameFileIdentity(fileIdentity(createdStats), fileIdentity(openedStats))) {
      throw new ProjectLockError();
    }
  } catch (error) {
    closeSync(descriptor);
    throw error instanceof ProjectLockError ? error : new ProjectLockError();
  }
  const createdIdentity = fileIdentity(createdStats);
  try {
    const lockRecord: LockRecord = {
      schemaVersion: 1,
      rootIdentity: context.rootIdentity,
      pid: process.pid,
      createdAt: Date.now(),
    };
    writeFileSync(descriptor, JSON.stringify(lockRecord), 'utf8');
    fsyncSync(descriptor);
    return callback(runtime);
  } finally {
    closeSync(descriptor);
    if (existsSync(runtime.lockPath)) {
      const currentStats = assertSecureRuntimeFile(runtime.lockPath);
      if (sameFileIdentity(createdIdentity, fileIdentity(currentStats))) {
        unlinkSync(runtime.lockPath);
      }
    }
  }
}
