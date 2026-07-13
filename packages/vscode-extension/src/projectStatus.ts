import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ProjectCliResolutionError,
  resolveProjectCli,
} from './projectCli';

export type ProjectIntegrationStatus =
  | 'not-installed'
  | 'not-enabled'
  | 'enabled'
  | 'conflict';

const STATE_FILE = '.web-source-inspector.json';
const MAXIMUM_STATE_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !value.startsWith('/')
    && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function validState(value: unknown): boolean {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isRecord(value.package)
    || value.package.name !== 'web-source-inspector'
    || typeof value.package.version !== 'string'
    || !['vite-vue2', 'vite-vue3', 'webpack-vue2', 'webpack-vue3'].includes(String(value.adapter))
    || !isRecord(value.profile)
    || typeof value.profile.vueVersion !== 'string'
    || !Array.isArray(value.configFiles)
    || value.configFiles.length === 0
    || !value.configFiles.every(isCanonicalRelativePath)
    || !isRecord(value.configModules)
    || !isRecord(value.configFileOwnership)
    || !isRecord(value.configFileBaseDigests)
    || !Array.isArray(value.nodes)
    || !isRecord(value.stateFile)
    || value.stateFile.ownership !== 'created'
    || typeof value.stateFile.fingerprint !== 'string') {
    return false;
  }
  const configFiles = new Set(value.configFiles as string[]);
  const matchingKeys = (record: Record<string, unknown>): boolean =>
    Object.keys(record).length === configFiles.size
    && Object.keys(record).every((key) => configFiles.has(key));
  if (!matchingKeys(value.configModules)
    || !matchingKeys(value.configFileOwnership)
    || !matchingKeys(value.configFileBaseDigests)
    || !Object.values(value.configModules).every((item) =>
      item === 'esm' || item === 'commonjs' || item === 'typescript')
    || !Object.values(value.configFileOwnership).every((item) =>
      item === 'created' || item === 'reused')
    || !Object.values(value.configFileBaseDigests).every((item) =>
      item === 'ABSENT' || (typeof item === 'string' && /^sha256:[a-f0-9]{64}$/u.test(item)))) {
    return false;
  }
  return value.nodes.every((node) => isRecord(node)
    && isCanonicalRelativePath(node.configPath)
    && configFiles.has(node.configPath)
    && ['import', 'plugin', 'loader', 'transport-hook'].includes(String(node.kind))
    && (node.ownership === 'created' || node.ownership === 'reused')
    && typeof node.fingerprint === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(node.fingerprint));
}

async function stateStatus(workspaceRoot: string): Promise<'absent' | 'valid' | 'invalid'> {
  const statePath = path.join(workspaceRoot, STATE_FILE);
  try {
    const stateFile = await lstat(statePath);
    if (!stateFile.isFile() || stateFile.isSymbolicLink() || stateFile.size > MAXIMUM_STATE_BYTES) {
      return 'invalid';
    }
    const parsed: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    return validState(parsed) ? 'valid' : 'invalid';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'invalid';
  }
}

export async function detectProjectIntegrationStatus(
  projectRoots: readonly string[],
  trustedWorkspaceRoots: readonly string[] = projectRoots,
): Promise<ProjectIntegrationStatus> {
  let installed = false;
  let enabled = false;
  for (const projectRoot of projectRoots) {
    try {
      await resolveProjectCli(projectRoot, trustedWorkspaceRoots);
      installed = true;
      const status = await stateStatus(projectRoot);
      if (status === 'invalid') {
        return 'conflict';
      }
      if (status === 'valid') {
        enabled = true;
      }
    } catch (error) {
      if (!(error instanceof ProjectCliResolutionError) || error.code !== 'PACKAGE_NOT_INSTALLED') {
        return 'conflict';
      }
    }
  }
  return enabled ? 'enabled' : installed ? 'not-enabled' : 'not-installed';
}
