import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const EXCLUDED_PATH_SEGMENTS = new Set(['node_modules', 'dist', '.git']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function declaresWorkspace(packageJsonPath: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (!isRecord(manifest)) {
      return false;
    }
    const { workspaces } = manifest;
    return Array.isArray(workspaces)
      || (isRecord(workspaces) && Array.isArray(workspaces.packages));
  } catch {
    return false;
  }
}

function canonicalizePath(pathname: string): string {
  return realpathSync(path.resolve(pathname));
}

function tryCanonicalizePath(pathname: string): string | null {
  try {
    return canonicalizePath(pathname);
  } catch {
    return null;
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function hasExcludedPathSegment(pathname: string): boolean {
  return pathname
    .split(/[\\/]+/)
    .some((segment) => EXCLUDED_PATH_SEGMENTS.has(
      process.platform === 'win32' ? segment.toLowerCase() : segment
    ));
}

export function findWorkspaceRoot(viteRoot: string, explicitRoot?: string): string {
  // 从真实路径向上扫描，避免 Junction 或 symlink 隐藏工作区根标记。
  const canonicalViteRoot = canonicalizePath(viteRoot);
  if (explicitRoot) {
    return canonicalizePath(path.resolve(canonicalViteRoot, explicitRoot));
  }

  let current = canonicalViteRoot;
  let packageRoot: string | undefined;
  while (true) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const packageJsonPath = path.join(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      if (declaresWorkspace(packageJsonPath)) {
        return current;
      }
      packageRoot ??= current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return packageRoot || canonicalViteRoot;
}

export function toWireRelativePath(workspaceRoot: string, filename: string): string | null {
  const canonicalRoot = tryCanonicalizePath(workspaceRoot);
  const canonicalFile = tryCanonicalizePath(filename);
  if (!canonicalRoot || !canonicalFile) {
    return null;
  }
  if (hasExcludedPathSegment(canonicalFile)) {
    return null;
  }
  const relative = path.relative(canonicalRoot, canonicalFile);
  if (!isPathInside(canonicalRoot, canonicalFile)) {
    return null;
  }
  const wirePath = relative.split(path.sep).join('/');
  if (wirePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return wirePath;
}

export function resolveVueSfcRequest(moduleId: string): string | null {
  if (moduleId.includes('?') || !moduleId.toLowerCase().endsWith('.vue')) {
    return null;
  }
  try {
    return realpathSync(moduleId);
  } catch {
    return null;
  }
}

function matchesPattern(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === 'string') {
    const normalized = pattern.replaceAll('\\', '/');
    return value.includes(normalized);
  }
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function shouldTransform(
  filename: string,
  workspaceRoot: string,
  sourceRoots: string[],
  include: Array<string | RegExp>,
  exclude: Array<string | RegExp>
): boolean {
  // 以真实路径建立源码边界，workspace 链接不因请求路径位于 node_modules 被误排除。
  const canonicalFilename = tryCanonicalizePath(filename);
  if (!canonicalFilename) {
    return false;
  }
  const normalized = canonicalFilename.replaceAll('\\', '/');
  if (!normalized.endsWith('.vue')
    || hasExcludedPathSegment(canonicalFilename)
    || exclude.some((pattern) => matchesPattern(normalized, pattern))) {
    return false;
  }
  if (include.length > 0 && !include.some((pattern) => matchesPattern(normalized, pattern))) {
    return false;
  }
  const allowedRoots = sourceRoots.length > 0 ? sourceRoots : [workspaceRoot];
  return allowedRoots.some((root) => {
    const canonicalRoot = tryCanonicalizePath(root);
    return canonicalRoot !== null && isPathInside(canonicalRoot, canonicalFilename);
  });
}
