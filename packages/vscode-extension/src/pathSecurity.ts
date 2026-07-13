import path from 'node:path';
import { promises as fs } from 'node:fs';

import type { RootMapping } from './types';

const MAX_WIRE_PATH_LENGTH = 4_096;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type PathRejectionReason =
  | 'NOT_STRING'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'CONTROL_CHARACTER'
  | 'ABSOLUTE_PATH'
  | 'BACKSLASH'
  | 'URI_OR_DRIVE'
  | 'HOME_PATH'
  | 'ENCODED_PATH'
  | 'INVALID_SEGMENT'
  | 'WINDOWS_DEVICE_NAME';

export type WirePathValidation =
  | { ok: true; segments: string[]; normalized: string }
  | { ok: false; reason: PathRejectionReason };

export class SourcePathError extends Error {
  public constructor(
    public readonly code: 'WORKSPACE_NOT_MATCHED' | 'PATH_REJECTED' | 'FILE_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'SourcePathError';
  }
}

/** 严格校验协议中的 POSIX 相对路径，避免平台规范化掩盖危险输入。 */
export function validateWireRelativePath(value: unknown): WirePathValidation {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'NOT_STRING' };
  }
  if (value.length === 0) {
    return { ok: false, reason: 'EMPTY' };
  }
  if (value.length > MAX_WIRE_PATH_LENGTH) {
    return { ok: false, reason: 'TOO_LONG' };
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return { ok: false, reason: 'CONTROL_CHARACTER' };
  }
  if (value.includes('\\')) {
    return { ok: false, reason: 'BACKSLASH' };
  }
  if (value.startsWith('/') || value.startsWith('//') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return { ok: false, reason: 'ABSOLUTE_PATH' };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.includes(':')) {
    return { ok: false, reason: 'URI_OR_DRIVE' };
  }
  if (value === '~' || value.startsWith('~/')) {
    return { ok: false, reason: 'HOME_PATH' };
  }
  // Wire path 永不 URL decode；拒绝百分号可消除编码穿越的歧义。
  if (value.includes('%')) {
    return { ok: false, reason: 'ENCODED_PATH' };
  }

  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        /[<>"|?*]/u.test(segment),
    )
  ) {
    return { ok: false, reason: 'INVALID_SEGMENT' };
  }
  if (segments.some((segment) => WINDOWS_DEVICE_NAME.test(segment))) {
    return { ok: false, reason: 'WINDOWS_DEVICE_NAME' };
  }

  return { ok: true, segments, normalized: segments.join('/') };
}

export function isCanonicalPathContained(
  rootPath: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalizedRoot = pathApi.resolve(rootPath);
  const normalizedTarget = pathApi.resolve(targetPath);
  const comparableRoot = platform === 'win32' ? normalizedRoot.toLocaleLowerCase('en-US') : normalizedRoot;
  const comparableTarget = platform === 'win32' ? normalizedTarget.toLocaleLowerCase('en-US') : normalizedTarget;
  const relative = pathApi.relative(comparableRoot, comparableTarget);

  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative));
}

export function selectLongestContainingRoot(
  targetPath: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return roots
    .filter((rootPath) => isCanonicalPathContained(rootPath, targetPath, platform))
    .sort((left, right) => right.length - left.length)[0];
}

export interface FileSystemAccess {
  realpath(targetPath: string): Promise<string>;
  stat(targetPath: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
}

const nodeFileSystem: FileSystemAccess = {
  realpath: (targetPath) => fs.realpath(targetPath),
  stat: (targetPath) => fs.stat(targetPath),
};

/** 解析并复核真实路径；目标必须同时位于 session 根和已打开 workspace 根内。 */
export async function resolveWorkspaceSourceFile(
  mapping: RootMapping | undefined,
  relativePath: unknown,
  fileSystem: FileSystemAccess = nodeFileSystem,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (!mapping) {
    throw new SourcePathError('WORKSPACE_NOT_MATCHED', 'rootKey 未映射到当前 workspace');
  }

  const validation = validateWireRelativePath(relativePath);
  if (!validation.ok) {
    throw new SourcePathError('PATH_REJECTED', `relativePath 被拒绝：${validation.reason}`);
  }

  let realSessionRoot: string;
  try {
    realSessionRoot = await fileSystem.realpath(mapping.sessionRoot);
  } catch {
    throw new SourcePathError('WORKSPACE_NOT_MATCHED', 'session 根目录不可用');
  }

  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const lexicalTarget = pathApi.resolve(realSessionRoot, ...validation.segments);
  if (!isCanonicalPathContained(realSessionRoot, lexicalTarget, platform)) {
    throw new SourcePathError('PATH_REJECTED', '目标路径越出 session 根目录');
  }

  let realTarget: string;
  try {
    realTarget = await fileSystem.realpath(lexicalTarget);
  } catch {
    throw new SourcePathError('FILE_NOT_FOUND', '目标文件不存在');
  }

  if (!isCanonicalPathContained(realSessionRoot, realTarget, platform)) {
    throw new SourcePathError('PATH_REJECTED', '符号链接目标越出 session 根目录');
  }

  const realWorkspaceRoots = await Promise.all(
    mapping.workspaceRoots.map(async (workspaceRoot) => {
      try {
        return await fileSystem.realpath(workspaceRoot);
      } catch {
        return undefined;
      }
    }),
  );
  const allowedRoots = realWorkspaceRoots.filter((rootPath): rootPath is string => typeof rootPath === 'string');
  if (!selectLongestContainingRoot(realTarget, allowedRoots, platform)) {
    throw new SourcePathError('PATH_REJECTED', '目标文件不属于当前已打开 workspace');
  }

  let targetStat: Awaited<ReturnType<FileSystemAccess['stat']>>;
  try {
    targetStat = await fileSystem.stat(realTarget);
  } catch {
    throw new SourcePathError('FILE_NOT_FOUND', '目标文件不存在');
  }
  if (!targetStat.isFile()) {
    throw new SourcePathError('FILE_NOT_FOUND', '目标不是普通文件');
  }

  return realTarget;
}
