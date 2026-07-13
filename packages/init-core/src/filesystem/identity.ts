import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { digestCanonical, sha256 } from '../digest';
import type { FileIdentity, PlannedTargetIdentity } from '../plan/types';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const WINDOWS_RESERVED_SEGMENT_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export class WorkspacePathError extends Error {
  readonly code = 'PATH_REJECTED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export interface WorkspaceContext {
  rootPath: string;
  rootIdentity: string;
  rootDirectoryIdentity: FileIdentity;
}

export interface CapturedTarget {
  absolutePath: string;
  identity: PlannedTargetIdentity;
  digest: string | 'ABSENT';
  content: string | null;
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function pathsEqual(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function bigintText(value: bigint | undefined, fallback: number): string {
  return value?.toString() ?? BigInt(Math.max(0, Math.trunc(fallback))).toString();
}

export function fileIdentity(stats: Stats): FileIdentity {
  const bigintStats = stats as typeof stats & {
    dev: bigint | number;
    ino: bigint | number;
    birthtimeNs?: bigint;
  };
  return {
    device: String(bigintStats.dev),
    inode: String(bigintStats.ino),
    birthtimeNs: bigintText(
      bigintStats.birthtimeNs,
      Number(stats.birthtimeMs) * 1_000_000,
    ),
    mode: Number(stats.mode),
  };
}

export function sameFileIdentity(
  left: FileIdentity | undefined,
  right: FileIdentity | undefined,
): boolean {
  return Boolean(left && right
    && left.device === right.device
    && left.inode === right.inode
    && left.birthtimeNs === right.birthtimeNs
    && left.mode === right.mode);
}

export function normalizeRelativeTarget(relativePath: string): string {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.length > 1024
    || CONTROL_CHARACTER_PATTERN.test(relativePath)
    || relativePath.includes('\\')
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || relativePath.includes(':')
  ) {
    throw new WorkspacePathError('目标必须是规范 workspace 相对路径');
  }
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (
      !segment
      || segment === '.'
      || segment === '..'
      || /[. ]$/u.test(segment)
      || WINDOWS_RESERVED_SEGMENT_PATTERN.test(segment)
    ) {
      throw new WorkspacePathError('目标路径包含不安全路径段');
    }
  }
  return segments.join('/');
}

function assertOrdinaryDirectory(directoryPath: string): void {
  const stats = lstatSync(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new WorkspacePathError('workspace 及目标父目录必须是普通目录');
  }
}

export function resolveWorkspaceContext(workspaceRoot: string): WorkspaceContext {
  const requestedRoot = path.resolve(workspaceRoot);
  assertOrdinaryDirectory(requestedRoot);
  const initialIdentity = fileIdentity(lstatSync(requestedRoot));
  const canonicalRoot = realpathSync.native(requestedRoot);
  if (!pathsEqual(requestedRoot, canonicalRoot)) {
    throw new WorkspacePathError('workspace 不能经过 symlink、Junction 或 reparse point');
  }
  const finalIdentity = fileIdentity(lstatSync(canonicalRoot));
  if (!sameFileIdentity(initialIdentity, finalIdentity)) {
    throw new WorkspacePathError('解析 workspace 时目录 identity 已变化');
  }
  return {
    rootPath: canonicalRoot,
    rootIdentity: digestCanonical([
      'workspace-root-v2',
      initialIdentity.device,
      initialIdentity.inode,
      initialIdentity.birthtimeNs,
    ]),
    rootDirectoryIdentity: initialIdentity,
  };
}

function assertInsideWorkspace(context: WorkspaceContext, absolutePath: string): void {
  const relative = path.relative(context.rootPath, absolutePath);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return;
  }
  throw new WorkspacePathError('目标路径越过 workspace 边界');
}

function assertSafeAncestors(context: WorkspaceContext, parentPath: string): void {
  assertInsideWorkspace(context, parentPath);
  const relativeParent = path.relative(context.rootPath, parentPath);
  let current = context.rootPath;
  assertOrdinaryDirectory(current);
  if (!sameFileIdentity(context.rootDirectoryIdentity, fileIdentity(lstatSync(current)))) {
    throw new WorkspacePathError('workspace 根目录 identity 已变化');
  }
  if (!relativeParent) {
    return;
  }
  for (const segment of relativeParent.split(path.sep)) {
    current = path.join(current, segment);
    assertOrdinaryDirectory(current);
    const canonical = realpathSync.native(current);
    if (!pathsEqual(current, canonical)) {
      throw new WorkspacePathError('目标祖先不能是 symlink、Junction 或 reparse point');
    }
  }
}

function readStableFile(absolutePath: string, expected: FileIdentity): string {
  const descriptor = openSync(absolutePath, 'r');
  try {
    const openedStats = fstatSync(descriptor);
    const openedIdentity = fileIdentity(openedStats);
    if (!openedStats.isFile()
      || openedStats.nlink !== 1
      || !sameFileIdentity(expected, openedIdentity)) {
      throw new WorkspacePathError('读取配置时文件 identity 已变化');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

export function captureTarget(
  context: WorkspaceContext,
  requestedPath: string,
): CapturedTarget {
  const relativePath = normalizeRelativeTarget(requestedPath);
  const absolutePath = path.resolve(context.rootPath, ...relativePath.split('/'));
  assertInsideWorkspace(context, absolutePath);
  const parentPath = path.dirname(absolutePath);
  assertSafeAncestors(context, parentPath);
  const parentStats = lstatSync(parentPath);
  const parentIdentity = fileIdentity(parentStats);

  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return {
      absolutePath,
      digest: 'ABSENT',
      content: null,
      identity: {
        rootIdentity: context.rootIdentity,
        path: relativePath,
        exists: false,
        kind: 'absent',
        parentIdentity,
      },
    };
  }

  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new WorkspacePathError('目标必须是普通非链接文件');
  }
  const targetIdentity = fileIdentity(stats);
  const canonicalPath = realpathSync.native(absolutePath);
  if (!pathsEqual(absolutePath, canonicalPath)) {
    throw new WorkspacePathError('目标不能是 symlink、Junction 或 reparse point');
  }
  const content = readStableFile(absolutePath, targetIdentity);
  const finalStats = lstatSync(absolutePath);
  if (!finalStats.isFile()
    || finalStats.nlink !== 1
    || !sameFileIdentity(targetIdentity, fileIdentity(finalStats))) {
    throw new WorkspacePathError('读取配置期间文件 identity 已变化');
  }
  return {
    absolutePath,
    content,
    digest: sha256(content),
    identity: {
      rootIdentity: context.rootIdentity,
      path: relativePath,
      exists: true,
      kind: 'file',
      parentIdentity,
      fileIdentity: targetIdentity,
      realPathIdentity: sha256(comparablePath(canonicalPath)),
    },
  };
}

export function sameTargetIdentity(
  left: PlannedTargetIdentity,
  right: PlannedTargetIdentity,
): boolean {
  return left.rootIdentity === right.rootIdentity
    && left.path === right.path
    && left.exists === right.exists
    && left.kind === right.kind
    && sameFileIdentity(left.parentIdentity, right.parentIdentity)
    && (left.exists
      ? sameFileIdentity(left.fileIdentity, right.fileIdentity)
        && left.realPathIdentity === right.realPathIdentity
      : true);
}
