import type { AdapterKind, BundlerKind, ConfigModuleKind, ProjectProfile } from '../types';
import type { AstOperation, NodeOwnership } from '../plan/types';
import { digestCanonical } from '../digest';

export const INTEGRATION_STATE_PATH = '.web-source-inspector.json';
export const INTEGRATION_STATE_SCHEMA_VERSION = 1 as const;

export function legacyIntegrationStateFingerprint(): string {
  return digestCanonical(['state-file', INTEGRATION_STATE_SCHEMA_VERSION]);
}

export interface IntegrationStateNode {
  configPath: string;
  kind: AstOperation['kind'];
  ownership: NodeOwnership;
  fingerprint: string;
  details?: Readonly<Record<string, string>>;
}

export interface IntegrationState {
  schemaVersion: typeof INTEGRATION_STATE_SCHEMA_VERSION;
  package: {
    name: 'web-source-inspector';
    version: string;
  };
  adapter: AdapterKind;
  profile: {
    bundler: BundlerKind;
    vueVersion: string;
    viteVersion?: string;
    webpackVersion?: string;
    vueLoaderVersion?: string;
  };
  configFiles: string[];
  configModules: Record<string, ConfigModuleKind>;
  configFileOwnership: Record<string, NodeOwnership>;
  configFileBaseDigests: Record<string, string | 'ABSENT'>;
  nodes: IntegrationStateNode[];
  stateFile: {
    ownership: NodeOwnership;
    fingerprint: string;
  };
}

export function integrationStateFingerprint(state: IntegrationState): string {
  const { fingerprint: _fingerprint, ...stateFile } = state.stateFile;
  return digestCanonical([
    'integration-state-v1',
    {
      ...state,
      stateFile,
    },
  ]);
}

export function createIntegrationState(
  profile: ProjectProfile,
  configOperations: ReadonlyArray<{
    path: string;
    moduleKind: ConfigModuleKind;
    fileOwnership: NodeOwnership;
    baseDigest: string | 'ABSENT';
    operations: readonly AstOperation[];
  }>,
  packageVersion = '0.1.0',
): IntegrationState {
  if (!profile.adapter) {
    throw new Error('缺少 Adapter，不能创建 integration state');
  }
  const state: IntegrationState = {
    schemaVersion: INTEGRATION_STATE_SCHEMA_VERSION,
    package: { name: 'web-source-inspector', version: packageVersion },
    adapter: profile.adapter,
    profile: {
      bundler: profile.bundler,
      vueVersion: profile.vue?.version ?? 'unknown',
      ...(profile.vite ? { viteVersion: profile.vite.version } : {}),
      ...(profile.webpack ? { webpackVersion: profile.webpack.version } : {}),
      ...(profile.vueLoader ? { vueLoaderVersion: profile.vueLoader.version } : {}),
    },
    configFiles: [...new Set(configOperations.map((item) => item.path))].sort(),
    configModules: Object.fromEntries(
      configOperations.map((item) => [item.path, item.moduleKind]),
    ),
    configFileOwnership: Object.fromEntries(
      configOperations.map((item) => [item.path, item.fileOwnership]),
    ),
    configFileBaseDigests: Object.fromEntries(
      configOperations.map((item) => [item.path, item.baseDigest]),
    ),
    nodes: configOperations.flatMap((item) => item.operations.map((operation) => ({
      configPath: item.path,
      kind: operation.kind,
      ownership: operation.ownership,
      fingerprint: operation.fingerprint,
      ...(operation.details ? { details: operation.details } : {}),
    }))),
    stateFile: {
      ownership: 'created',
      fingerprint: legacyIntegrationStateFingerprint(),
    },
  };
  state.stateFile.fingerprint = integrationStateFingerprint(state);
  return state;
}
