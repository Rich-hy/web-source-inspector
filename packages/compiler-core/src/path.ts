import path from 'node:path';
import {
  getWireRelativePathError,
  isWireRelativePath
} from '@web-source-inspector/protocol';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const WINDOWS_DEVICE_PATH_PATTERN = /^(?:\\\\[?.]\\|\/\/[?.]\/)/;
const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATTERN = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;

function isWindowsAbsolutePath(value: string): boolean {
  return (
    WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(value) || WINDOWS_UNC_PATTERN.test(value)
  );
}

export class WirePathError extends Error {
  readonly code = 'PATH_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'WirePathError';
  }
}

/** 对内部原生相对路径做一次分隔符转换，输出可直接上协议的路径。 */
export function normalizeRelativePathForWire(relativePath: string): string {
  if (typeof relativePath !== 'string') {
    throw new TypeError('相对路径必须是字符串');
  }
  if (
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    WINDOWS_DEVICE_PATH_PATTERN.test(relativePath)
  ) {
    throw new WirePathError('协议路径不能是绝对路径、UNC 或设备路径');
  }
  const wirePath = relativePath.replace(/\\/g, '/');
  const reason = getWireRelativePathError(wirePath);
  if (reason) {
    throw new WirePathError(reason);
  }
  return wirePath;
}

/** 校验已经位于协议边界上的路径，不接受反斜杠自动修正。 */
export function normalizeWireRelativePath(relativePath: string): string {
  const reason = getWireRelativePathError(relativePath);
  if (reason) {
    throw new WirePathError(reason);
  }
  return relativePath;
}

export function tryNormalizeRelativePathForWire(
  relativePath: string
): { ok: true; value: string } | { ok: false; reason: string } {
  try {
    return { ok: true, value: normalizeRelativePathForWire(relativePath) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : '路径无效'
    };
  }
}

/** rootKey 只依赖规范身份；真实目录边界仍由 IDE realpath 二次校验。 */
export function normalizeRootIdentity(rootPath: string): string {
  if (
    typeof rootPath !== 'string' ||
    rootPath.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(rootPath) ||
    WINDOWS_DEVICE_PATH_PATTERN.test(rootPath) ||
    /^file:/i.test(rootPath)
  ) {
    throw new WirePathError('workspace 根路径格式无效');
  }

  if (isWindowsAbsolutePath(rootPath)) {
    const normalized = path.win32.normalize(rootPath).replace(/\\/g, '/');
    // Windows 路径身份比较不区分大小写，避免盘符或目录大小写产生多个 rootKey。
    return normalized.replace(/\/$/, '').toLocaleLowerCase('en-US');
  }
  if (!path.posix.isAbsolute(rootPath)) {
    throw new WirePathError('workspace 根路径必须是绝对路径');
  }
  const normalized = path.posix.normalize(rootPath);
  return normalized === '/' ? normalized : normalized.replace(/\/$/, '');
}

export function relativePathFromRoot(rootPath: string, targetPath: string): string {
  const useWindowsRules = isWindowsAbsolutePath(rootPath);
  if (useWindowsRules !== isWindowsAbsolutePath(targetPath)) {
    throw new WirePathError('workspace 根与目标路径格式不一致');
  }
  const relativePath = useWindowsRules
    ? path.win32.relative(rootPath, targetPath)
    : path.posix.relative(rootPath, targetPath);
  return normalizeRelativePathForWire(relativePath);
}

export { isWireRelativePath };
