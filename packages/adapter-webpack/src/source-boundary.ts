import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { relativePathFromRoot } from '@web-source-inspector/compiler-core';

export type CanonicalSourceClassification =
  | {
      kind: 'inspectable';
      canonicalPath: string;
      relativePath: string;
    }
  | {
      kind: 'dependency' | 'outside';
      canonicalPath: string;
    }
  | {
      kind: 'unresolved';
    };

export interface WebpackSourceBoundary {
  /** 仅用于解析 webpack、Vue compiler 等项目本地工具链。 */
  readonly projectRoot: string;
  /** Manifest、rootKey 和源码信任边界使用的 workspace 根目录。 */
  readonly workspaceRoot: string;
  readonly canonicalWorkspaceRoot: string | null;
}

export function createWebpackSourceBoundary(
  projectRoot: string,
  workspaceRoot: string,
): WebpackSourceBoundary {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  return Object.freeze({
    projectRoot: resolvedProjectRoot,
    workspaceRoot: resolvedWorkspaceRoot,
    canonicalWorkspaceRoot: tryRealpath(resolvedWorkspaceRoot),
  });
}

/**
 * 仅以真实路径决定源码是否可信：node_modules 下的 workspace link 会解析到源码，
 * 而失效链接或无法 realpath 的请求一律旁路。
 */
export function classifyWebpackSource(
  boundary: WebpackSourceBoundary,
  resourcePath: string,
): CanonicalSourceClassification {
  const canonicalPath = tryRealpath(resourcePath);
  const workspaceRoot = boundary.canonicalWorkspaceRoot;
  if (!canonicalPath || !workspaceRoot) {
    return { kind: 'unresolved' };
  }

  if (isDependencyPath(canonicalPath)) {
    return { kind: 'dependency', canonicalPath };
  }

  if (isPathInside(workspaceRoot, canonicalPath)) {
    try {
      return {
        kind: 'inspectable',
        canonicalPath,
        relativePath: relativePathFromRoot(workspaceRoot, canonicalPath),
      };
    } catch {
      // 规范路径不能安全编码为协议相对路径时同样不可作为受信任源码。
      return { kind: 'outside', canonicalPath };
    }
  }

  // pnpm/npm/yarn 的 link 请求在 realpath 后可能落到工作区外的包存储。
  return isDependencyPath(resourcePath)
    ? { kind: 'dependency', canonicalPath }
    : { kind: 'outside', canonicalPath };
}

export function resolveWebpackWorkspaceRoot(
  projectRoot: string,
  explicitWorkspaceRoot?: string,
): string {
  const resolvedProjectRoot = path.resolve(projectRoot);
  if (explicitWorkspaceRoot) {
    return path.resolve(resolvedProjectRoot, explicitWorkspaceRoot);
  }

  let current = resolvedProjectRoot;
  let packageRoot: string | null = null;
  while (true) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml')) || hasWorkspaceDeclaration(current)) {
      return current;
    }
    if (!packageRoot && existsSync(path.join(current, 'package.json'))) {
      packageRoot = current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return packageRoot ?? resolvedProjectRoot;
    }
    current = parent;
  }
}

function tryRealpath(targetPath: string): string | null {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function hasWorkspaceDeclaration(directory: string): boolean {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const workspaces = (value as { workspaces?: unknown }).workspaces;
    return Array.isArray(workspaces)
      || (typeof workspaces === 'object' && workspaces !== null && Array.isArray(
        (workspaces as { packages?: unknown }).packages,
      ));
  } catch {
    return false;
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isDependencyPath(value: string): boolean {
  const segments = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.some((segment, index) => (
    segment === 'node_modules'
    || segment === '.pnpm'
    || segment === '.pnpm-store'
    || segment === '.yarn'
    || (segment === 'store' && segments[index - 1] === 'pnpm')
  ));
}
