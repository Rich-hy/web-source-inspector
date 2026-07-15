import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const PACKAGE_NAME_PATTERN = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** 仅使用 workspace 相对路径作为 package 解析锚点，避免把物理 store 路径带到诊断或 profile。 */
export interface ProjectPackageAnchor {
  packageJsonPath: string;
}

/** package.json 中兼容性层允许读取的最小事实集合。 */
export interface ProjectPackageFact extends ProjectPackageAnchor {
  name: string | undefined;
  version: string | undefined;
  peerDependencies: Readonly<Record<string, string>>;
  engines: Readonly<{
    node?: string;
  }>;
}

/** 由包名查找到的事实已经验证 manifest.name 与请求包名一致。 */
export interface ResolvedProjectPackageFact extends ProjectPackageFact {
  name: string;
}

export interface FindProjectPackageFactOptions {
  anchor?: ProjectPackageAnchor;
}

/**
 * 读取受信任 workspace 内的 manifest。此函数不会返回绝对路径，也不会暴露 scripts 等无关字段。
 */
export function readProjectPackageFact(
  workspaceRoot: string,
  packageJsonPath = 'package.json',
): ProjectPackageFact | undefined {
  const resolvedWorkspaceRoot = resolveWorkspaceRoot(workspaceRoot);
  if (!resolvedWorkspaceRoot) {
    return undefined;
  }
  const resolvedManifestPath = resolveWorkspaceManifestPath(
    resolvedWorkspaceRoot,
    packageJsonPath,
  );
  if (!resolvedManifestPath) {
    return undefined;
  }
  return readPackageFact(resolvedWorkspaceRoot, resolvedManifestPath);
}

/**
 * 从当前 manifest anchor 按 Node 的 node_modules 层级寻找包，但只接受逻辑路径仍在 workspace 内的包。
 */
export function findProjectPackageAnchor(
  workspaceRoot: string,
  packageName: string,
  options: FindProjectPackageFactOptions = {},
): ProjectPackageAnchor | undefined {
  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    return undefined;
  }
  const resolvedWorkspaceRoot = resolveWorkspaceRoot(workspaceRoot);
  if (!resolvedWorkspaceRoot) {
    return undefined;
  }
  const anchorPath = resolveWorkspaceManifestPath(
    resolvedWorkspaceRoot,
    options.anchor?.packageJsonPath ?? 'package.json',
  );
  if (!anchorPath) {
    return undefined;
  }

  const segments = packageName.split('/');
  let currentDirectory = path.dirname(anchorPath);
  while (isWorkspacePath(resolvedWorkspaceRoot, currentDirectory, true)) {
    const candidate = path.join(currentDirectory, 'node_modules', ...segments, 'package.json');
    if (isWorkspacePath(resolvedWorkspaceRoot, candidate) && existsSync(candidate)) {
      const fact = readPackageFact(resolvedWorkspaceRoot, candidate);
      if (fact?.name === packageName) {
        return { packageJsonPath: fact.packageJsonPath };
      }
    }
    if (currentDirectory === resolvedWorkspaceRoot) {
      break;
    }
    currentDirectory = path.dirname(currentDirectory);
  }
  return undefined;
}

export function findProjectPackageFact(
  workspaceRoot: string,
  packageName: string,
  options: FindProjectPackageFactOptions = {},
): ResolvedProjectPackageFact | undefined {
  const anchor = findProjectPackageAnchor(workspaceRoot, packageName, options);
  if (!anchor) {
    return undefined;
  }
  const fact = readProjectPackageFact(workspaceRoot, anchor.packageJsonPath);
  if (!fact || fact.name !== packageName) {
    return undefined;
  }
  return fact as ResolvedProjectPackageFact;
}

/**
 * 验证指定 anchor 实际可解析 package subpath。只返回布尔事实，永不返回 Node/pnpm 的物理解析路径。
 */
export function canResolveProjectPackageSpecifier(
  workspaceRoot: string,
  specifier: string,
  options: FindProjectPackageFactOptions = {},
): boolean {
  const packageName = packageNameFromSpecifier(specifier);
  if (!packageName) {
    return false;
  }
  const resolvedWorkspaceRoot = resolveWorkspaceRoot(workspaceRoot);
  if (!resolvedWorkspaceRoot) {
    return false;
  }
  const anchorPath = resolveWorkspaceManifestPath(
    resolvedWorkspaceRoot,
    options.anchor?.packageJsonPath ?? 'package.json',
  );
  if (!anchorPath || !findProjectPackageAnchor(workspaceRoot, packageName, options)) {
    return false;
  }
  try {
    createRequire(anchorPath).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

function resolveWorkspaceRoot(workspaceRoot: string): string | undefined {
  try {
    return realpathSync(workspaceRoot);
  } catch {
    return undefined;
  }
}

function resolveWorkspaceManifestPath(
  workspaceRoot: string,
  packageJsonPath: string,
): string | undefined {
  if (!isSafeRelativePackageJsonPath(packageJsonPath)) {
    return undefined;
  }
  const candidate = path.resolve(workspaceRoot, packageJsonPath);
  return isWorkspacePath(workspaceRoot, candidate) && existsSync(candidate)
    ? candidate
    : undefined;
}

function isSafeRelativePackageJsonPath(packageJsonPath: string): boolean {
  if (!packageJsonPath || path.isAbsolute(packageJsonPath) || path.basename(packageJsonPath) !== 'package.json') {
    return false;
  }
  return !packageJsonPath.split(/[\\/]/u).some((segment) => segment === '..');
}

function isWorkspacePath(workspaceRoot: string, targetPath: string, allowRoot = false): boolean {
  const relativePath = path.relative(workspaceRoot, targetPath);
  if (relativePath === '') {
    return allowRoot;
  }
  return !path.isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`);
}

function readPackageFact(
  workspaceRoot: string,
  absoluteManifestPath: string,
): ProjectPackageFact | undefined {
  const rawManifest = readJsonObject(absoluteManifestPath);
  if (!rawManifest) {
    return undefined;
  }
  const {
    name: rawName,
    version: rawVersion,
    peerDependencies: rawPeerDependencies,
    engines: rawEngines,
  } = rawManifest;
  const relativePath = toWorkspaceRelativePath(workspaceRoot, absoluteManifestPath);
  if (!relativePath) {
    return undefined;
  }
  const engineNode = readStringRecord(rawEngines)?.node;
  return {
    name: typeof rawName === 'string' ? rawName : undefined,
    version: typeof rawVersion === 'string' ? rawVersion : undefined,
    peerDependencies: readStringRecord(rawPeerDependencies) ?? {},
    engines: engineNode === undefined ? {} : { node: engineNode },
    packageJsonPath: relativePath,
  };
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      record[key] = item;
    }
  }
  return record;
}

function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string | undefined {
  if (!isWorkspacePath(workspaceRoot, absolutePath)) {
    return undefined;
  }
  const relativePath = path.relative(workspaceRoot, absolutePath).split(path.sep).join('/');
  return relativePath || undefined;
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return undefined;
  }
  const segments = specifier.split('/');
  const packageName = specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0];
  return packageName && PACKAGE_NAME_PATTERN.test(packageName) ? packageName : undefined;
}
