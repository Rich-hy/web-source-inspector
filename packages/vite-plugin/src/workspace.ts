import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function findWorkspaceRoot(viteRoot: string, explicitRoot?: string): string {
  if (explicitRoot) {
    return realpathSync(path.resolve(viteRoot, explicitRoot));
  }

  let current = path.resolve(viteRoot);
  let packageRoot: string | undefined;
  while (true) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      return realpathSync(current);
    }
    if (!packageRoot && existsSync(path.join(current, 'package.json'))) {
      packageRoot = current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return realpathSync(packageRoot || viteRoot);
}

export function toWireRelativePath(workspaceRoot: string, filename: string): string | null {
  let canonicalFile: string;
  try {
    canonicalFile = realpathSync(filename);
  } catch {
    return null;
  }
  const relative = path.relative(workspaceRoot, canonicalFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
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
  const normalized = filename.replaceAll('\\', '/');
  if (!normalized.endsWith('.vue')
    || normalized.includes('/node_modules/')
    || normalized.includes('/dist/')
    || normalized.includes('/.git/')
    || exclude.some((pattern) => matchesPattern(normalized, pattern))) {
    return false;
  }
  if (include.length > 0 && !include.some((pattern) => matchesPattern(normalized, pattern))) {
    return false;
  }
  const allowedRoots = sourceRoots.length > 0 ? sourceRoots : [workspaceRoot];
  return allowedRoots.some((root) => {
    const relative = path.relative(root, filename);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}
