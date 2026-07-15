import semver from 'semver';
import { canonicalJson } from '../digest';
import { normalizeRelativeTarget, type CapturedTarget } from '../filesystem/identity';
import type {
  AstOperation,
  BrowserAccessMode,
  BrowserAccessPreviousShape,
} from '../plan/types';
import {
  INTEGRATION_STATE_SCHEMA_VERSION,
  INTEGRATION_STATE_PATH,
  integrationStateFingerprint,
  legacyIntegrationStateFingerprint,
  type IntegrationState,
  type IntegrationStateNode,
} from './types';

// 仅用于读取和卸载历史 state；当前项目兼容性必须由共享 evaluator 判断。
const LEGACY_STATE_VITE_RANGE = '>=2 <7';
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const NODE_DETAIL_KEYS = new Set([
  'action',
  'allowedOrigin',
  'binding',
  'browserAccessMode',
  'browserAccessOriginalFingerprint',
  'browserAccessOriginalShape',
  'browserTransport',
  'chainHookOwnership',
  'devServerOwnership',
  'exported',
  'hookContainerOwnership',
  'hookName',
  'legacyCreatedCompatible',
  'legacyFingerprint',
  'module',
  'nextAnchor',
  'parameter',
  'postNext',
  'postPrevious',
  'preNext',
  'prePrevious',
  'previousAnchor',
]);
const NODE_ACTIONS = new Set([
  'inserted-before-vue',
  'moved-before-vue',
  'inserted-before-vue-loader',
  'moved-before-vue-loader',
  'wrapped-static-hook',
]);
const BROWSER_ACCESS_MODES = new Set<BrowserAccessMode>(['loopback', 'same-machine']);
const BROWSER_ACCESS_PREVIOUS_SHAPES = new Set<BrowserAccessPreviousShape>([
  'no-arguments',
  'property-absent',
  'loopback',
  'same-machine',
]);

export class IntegrationStateError extends Error {
  readonly code = 'TRANSACTION_CONFLICT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'IntegrationStateError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function validConfigPath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return normalizeRelativeTarget(value) === value && value !== INTEGRATION_STATE_PATH;
  } catch {
    return false;
  }
}

function hasExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(record).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length
    && actualKeys.every((key, index) => key === sortedExpected[index]);
}

function validAnchor(value: string | undefined): boolean {
  return value === undefined || value === 'START' || value === 'END' || validFingerprint(value);
}

function validBrowserAccessMode(value: unknown): value is BrowserAccessMode {
  return typeof value === 'string' && BROWSER_ACCESS_MODES.has(value as BrowserAccessMode);
}

function validBrowserAccessPreviousShape(value: unknown): value is BrowserAccessPreviousShape {
  return typeof value === 'string'
    && BROWSER_ACCESS_PREVIOUS_SHAPES.has(value as BrowserAccessPreviousShape);
}

function validNodeDetails(value: Record<string, unknown>): value is Record<string, string> {
  if (Object.keys(value).some((key) => !NODE_DETAIL_KEYS.has(key))
    || Object.values(value).some((item) => typeof item !== 'string' || item.length === 0)
    || typeof value.binding !== 'string'
    || !IDENTIFIER_PATTERN.test(value.binding)
    || !validFingerprint(value.legacyFingerprint)
    || !['true', 'false'].includes(String(value.legacyCreatedCompatible))
    || (value.parameter !== undefined
      && (typeof value.parameter !== 'string' || !IDENTIFIER_PATTERN.test(value.parameter)))
    || (value.action !== undefined && !NODE_ACTIONS.has(String(value.action)))
    || (value.browserAccessMode !== undefined && !validBrowserAccessMode(value.browserAccessMode))
    || ((value.browserAccessOriginalShape === undefined)
      !== (value.browserAccessOriginalFingerprint === undefined))
    || (value.browserAccessOriginalShape !== undefined
      && !validBrowserAccessPreviousShape(value.browserAccessOriginalShape))
    || (value.browserAccessOriginalFingerprint !== undefined
      && !validFingerprint(value.browserAccessOriginalFingerprint))
    || (value.browserTransport !== undefined && value.browserTransport !== 'raw')
    || (value.hookName !== undefined && !['before', 'setupMiddlewares'].includes(String(value.hookName)))
    || (value.module !== undefined && value.module !== 'web-source-inspector/vite')
    || (value.exported !== undefined && ![
      'WebSourceInspectorWebpackPlugin',
      'createWebSourceInspectorBrowserMiddleware',
    ].includes(String(value.exported)))
    || (value.chainHookOwnership !== undefined && value.chainHookOwnership !== 'created')
    || (value.devServerOwnership !== undefined && value.devServerOwnership !== 'created')
    || (value.hookContainerOwnership !== undefined && value.hookContainerOwnership !== 'reused')
    || !validAnchor(value.previousAnchor as string | undefined)
    || !validAnchor(value.nextAnchor as string | undefined)
    || !validAnchor(value.prePrevious as string | undefined)
    || !validAnchor(value.preNext as string | undefined)
    || !validAnchor(value.postPrevious as string | undefined)
    || !validAnchor(value.postNext as string | undefined)
    || ((value.previousAnchor === undefined) !== (value.nextAnchor === undefined))
    || ([value.prePrevious, value.preNext, value.postPrevious, value.postNext]
      .filter((item) => item !== undefined).length % 4 !== 0)) {
    return false;
  }
  return true;
}

function parseNode(value: unknown): IntegrationStateNode | undefined {
  if (!isPlainObject(value)
    || !hasExactKeys(
      value,
      value.details === undefined
        ? ['configPath', 'kind', 'ownership', 'fingerprint']
        : ['configPath', 'kind', 'ownership', 'fingerprint', 'details'],
    )
    || !validConfigPath(value.configPath)
    || !['import', 'plugin', 'loader', 'transport-hook'].includes(String(value.kind))
    || (value.ownership !== 'created' && value.ownership !== 'reused')
    || !validFingerprint(value.fingerprint)
    || !isPlainObject(value.details)
    || !validNodeDetails(value.details)) {
    return undefined;
  }
  return {
    configPath: value.configPath,
    kind: value.kind as IntegrationStateNode['kind'],
    ownership: value.ownership,
    fingerprint: value.fingerprint,
    details: { ...value.details },
  };
}

function validProfile(
  adapter: unknown,
  profile: Record<string, unknown>,
): boolean {
  const bundler = String(profile.bundler);
  const validVueVersion = typeof profile.vueVersion === 'string'
    ? semver.valid(profile.vueVersion)
    : null;
  const vueVersion = validVueVersion ? semver.parse(validVueVersion) : null;
  const expectedVueMajor = String(adapter).endsWith('vue2') ? 2 : 3;
  if (!vueVersion || vueVersion.major !== expectedVueMajor) {
    return false;
  }
  if (bundler === 'vite') {
    return String(adapter).startsWith('vite-')
      && hasExactKeys(profile, ['bundler', 'vueVersion', 'viteVersion'])
      && typeof profile.viteVersion === 'string'
      && semver.valid(profile.viteVersion) !== null
      && semver.satisfies(profile.viteVersion, LEGACY_STATE_VITE_RANGE);
  }
  if (bundler !== 'webpack' && bundler !== 'vue-cli') {
    return false;
  }
  const validLoaderVersion = typeof profile.vueLoaderVersion === 'string'
    ? semver.valid(profile.vueLoaderVersion)
    : null;
  const loaderVersion = validLoaderVersion ? semver.parse(validLoaderVersion) : null;
  return String(adapter).startsWith('webpack-')
    && hasExactKeys(profile, [
      'bundler',
      'vueVersion',
      'webpackVersion',
      'vueLoaderVersion',
    ])
    && typeof profile.webpackVersion === 'string'
    && semver.valid(profile.webpackVersion) !== null
    && semver.satisfies(profile.webpackVersion, '>=4 <6')
    && Boolean(loaderVersion
      && (expectedVueMajor === 2
        ? loaderVersion.major === 15
        : loaderVersion.major === 16 || loaderVersion.major === 17));
}

const COMMON_NODE_DETAIL_KEYS = [
  'binding',
  'legacyFingerprint',
  'legacyCreatedCompatible',
] as const;

function hasExactDetailKeys(
  node: IntegrationStateNode,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const details = node.details;
  if (!details) {
    return false;
  }
  const keys = Object.keys(details);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(details, key))
    && keys.every((key) => allowed.has(key));
}

function validMovedNodeDetails(
  node: IntegrationStateNode,
  insertedAction: 'inserted-before-vue' | 'inserted-before-vue-loader',
  movedAction: 'moved-before-vue' | 'moved-before-vue-loader',
  optional: readonly string[] = [],
): boolean {
  const action = node.details?.action;
  if (action === insertedAction) {
    return node.ownership === 'created'
      && hasExactDetailKeys(node, [...COMMON_NODE_DETAIL_KEYS, 'action'], optional);
  }
  if (action === movedAction) {
    return node.ownership === 'reused'
      && hasExactDetailKeys(node, [
        ...COMMON_NODE_DETAIL_KEYS,
        'action',
        'prePrevious',
        'preNext',
        'postPrevious',
        'postNext',
      ], optional);
  }
  return action === undefined
    && node.ownership === 'reused'
    && hasExactDetailKeys(node, COMMON_NODE_DETAIL_KEYS, optional);
}

const VITE_BROWSER_ACCESS_DETAIL_KEYS = [
  'browserAccessMode',
  'browserAccessOriginalShape',
  'browserAccessOriginalFingerprint',
] as const;

function validVitePluginDetails(node: IntegrationStateNode): boolean {
  const details = node.details;
  const hasOriginalShape = details?.browserAccessOriginalShape !== undefined;
  const hasOriginalFingerprint = details?.browserAccessOriginalFingerprint !== undefined;
  if (hasOriginalShape !== hasOriginalFingerprint
    || (hasOriginalShape && (
      node.ownership !== 'reused'
      || details?.browserAccessMode === undefined
      || !validBrowserAccessPreviousShape(details.browserAccessOriginalShape)
      || !validFingerprint(details.browserAccessOriginalFingerprint)
    ))
    || (details?.browserAccessMode !== undefined
      && !validBrowserAccessMode(details.browserAccessMode))) {
    return false;
  }
  return validMovedNodeDetails(
    node,
    'inserted-before-vue',
    'moved-before-vue',
    VITE_BROWSER_ACCESS_DETAIL_KEYS,
  );
}

function validTransportHookDetails(node: IntegrationStateNode): boolean {
  const action = node.details?.action;
  if (action === 'wrapped-static-hook') {
    return hasExactDetailKeys(node, [
      ...COMMON_NODE_DETAIL_KEYS,
      'hookName',
      'action',
      'hookContainerOwnership',
    ]);
  }
  return action === undefined
    && hasExactDetailKeys(
      node,
      [...COMMON_NODE_DETAIL_KEYS, 'hookName'],
      ['devServerOwnership'],
    )
    && (node.details?.devServerOwnership === undefined || node.ownership === 'created');
}

function validNodeDetailShape(
  bundler: IntegrationState['profile']['bundler'],
  node: IntegrationStateNode,
): boolean {
  if (bundler === 'vite') {
    if (node.kind === 'import') {
      return hasExactDetailKeys(node, [...COMMON_NODE_DETAIL_KEYS, 'module']);
    }
    return node.kind === 'plugin'
      && validVitePluginDetails(node);
  }
  if (node.kind === 'import') {
    return hasExactDetailKeys(node, [...COMMON_NODE_DETAIL_KEYS, 'exported']);
  }
  if (node.kind === 'transport-hook') {
    return validTransportHookDetails(node);
  }
  if (bundler === 'vue-cli') {
    return (node.kind === 'plugin' || node.kind === 'loader')
      && hasExactDetailKeys(
        node,
        [...COMMON_NODE_DETAIL_KEYS, 'parameter'],
        ['chainHookOwnership'],
      )
      && (node.details?.chainHookOwnership === undefined || node.ownership === 'created');
  }
  if (node.kind === 'plugin') {
    return hasExactDetailKeys(
      node,
      COMMON_NODE_DETAIL_KEYS,
      ['allowedOrigin', 'browserTransport'],
    )
      && ((node.details?.allowedOrigin === undefined)
        === (node.details?.browserTransport === undefined));
  }
  return node.kind === 'loader'
    && validMovedNodeDetails(
      node,
      'inserted-before-vue-loader',
      'moved-before-vue-loader',
    );
}

function validNodeGraph(
  bundler: IntegrationState['profile']['bundler'],
  configFiles: readonly string[],
  nodes: readonly IntegrationStateNode[],
): boolean {
  return configFiles.every((configPath) => {
    const configNodes = nodes.filter((node) => node.configPath === configPath);
    const imports = configNodes.filter((node) => node.kind === 'import');
    const plugins = configNodes.filter((node) => node.kind === 'plugin');
    const loaders = configNodes.filter((node) => node.kind === 'loader');
    const hooks = configNodes.filter((node) => node.kind === 'transport-hook');
    if (!configNodes.every((node) => validNodeDetailShape(bundler, node))
      || plugins.length !== 1
      || (bundler !== 'vite' && loaders.length !== 1)) {
      return false;
    }
    if (bundler === 'vite') {
      return configNodes.length === 2
        && imports.length === 1
        && loaders.length === 0
        && hooks.length === 0
        && imports[0]?.details?.module === 'web-source-inspector/vite'
        && imports[0]?.details?.binding === plugins[0]?.details?.binding;
    }
    if (hooks.length > 1 || imports.length !== (hooks.length === 1 ? 2 : 1)) {
      return false;
    }
    const pluginImport = imports.find((node) =>
      node.details?.exported === 'WebSourceInspectorWebpackPlugin');
    const middlewareImport = imports.find((node) =>
      node.details?.exported === 'createWebSourceInspectorBrowserMiddleware');
    if (!pluginImport
      || pluginImport.details?.binding !== plugins[0]?.details?.binding
      || pluginImport.details?.binding !== loaders[0]?.details?.binding) {
      return false;
    }
    if (hooks.length === 1) {
      if (!middlewareImport
        || middlewareImport.details?.binding !== hooks[0]?.details?.binding
        || plugins[0]?.details?.allowedOrigin !== undefined
        || plugins[0]?.details?.browserTransport !== undefined) {
        return false;
      }
    } else if (middlewareImport
      || plugins[0]?.details?.browserTransport !== 'raw'
      || typeof plugins[0]?.details?.allowedOrigin !== 'string') {
      return false;
    }
    if (bundler === 'vue-cli') {
      return hooks.length === 1
        && imports.length === 2
        && plugins[0]?.details?.parameter !== undefined
        && plugins[0]?.details?.parameter === loaders[0]?.details?.parameter
        && plugins[0]?.details?.chainHookOwnership
          === loaders[0]?.details?.chainHookOwnership;
    }
    return configNodes.length === imports.length + 2 + hooks.length;
  });
}

export function parseIntegrationState(
  value: unknown,
  options: { allowLegacyStateFingerprint?: boolean } = {},
): IntegrationState {
  if (!isPlainObject(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'package',
      'adapter',
      'profile',
      'configFiles',
      'configModules',
      'configFileOwnership',
      'configFileBaseDigests',
      'nodes',
      'stateFile',
    ])
    || value.schemaVersion !== INTEGRATION_STATE_SCHEMA_VERSION
    || !isPlainObject(value.package)
    || !hasExactKeys(value.package, ['name', 'version'])
    || value.package.name !== 'web-source-inspector'
    || typeof value.package.version !== 'string'
    || value.package.version.length === 0
    || semver.valid(value.package.version) === null
    || !['vite-vue2', 'vite-vue3', 'webpack-vue2', 'webpack-vue3'].includes(String(value.adapter))
    || !isPlainObject(value.profile)
    || !validProfile(value.adapter, value.profile)
    || !Array.isArray(value.configFiles)
    || value.configFiles.length === 0
    || !value.configFiles.every(validConfigPath)
    || !isPlainObject(value.configModules)
    || !Object.values(value.configModules).every((item) =>
      ['esm', 'commonjs', 'typescript'].includes(String(item)))
    || !isPlainObject(value.configFileOwnership)
    || !Object.values(value.configFileOwnership).every((item) =>
      item === 'created' || item === 'reused')
    || !isPlainObject(value.configFileBaseDigests)
    || !Object.values(value.configFileBaseDigests).every((item) =>
      item === 'ABSENT' || validFingerprint(item))
    || !Array.isArray(value.nodes)
    || !isPlainObject(value.stateFile)
    || !hasExactKeys(value.stateFile, ['ownership', 'fingerprint'])
    || (value.stateFile.ownership !== 'created' && value.stateFile.ownership !== 'reused')
    || !validFingerprint(value.stateFile.fingerprint)) {
    throw new IntegrationStateError('integration state schema 无效');
  }
  const nodes = value.nodes.map(parseNode);
  if (nodes.some((node) => !node)) {
    throw new IntegrationStateError('integration state node 无效');
  }
  const configFiles = value.configFiles as string[];
  const configFileSet = new Set(configFiles);
  const parsedNodes = nodes as IntegrationStateNode[];
  const duplicateNodeKeys = new Set<string>();
  const hasDuplicateNode = parsedNodes.some((node) => {
    const key = `${node.configPath}\u0000${node.kind}\u0000${node.fingerprint}`;
    if (duplicateNodeKeys.has(key)) {
      return true;
    }
    duplicateNodeKeys.add(key);
    return false;
  });
  const ownership = value.configFileOwnership as Record<string, unknown>;
  const baseDigests = value.configFileBaseDigests as Record<string, unknown>;
  if (configFileSet.size !== configFiles.length
    || !hasExactKeys(value.configModules, configFiles)
    || !hasExactKeys(ownership, configFiles)
    || !hasExactKeys(baseDigests, configFiles)
    || parsedNodes.some((node) => !configFileSet.has(node.configPath))
    || configFiles.some((configPath) =>
      !parsedNodes.some((node) => node.configPath === configPath))
    || hasDuplicateNode
    || !validNodeGraph(
      value.profile.bundler as IntegrationState['profile']['bundler'],
      configFiles,
      parsedNodes,
    )
    || configFiles.some((configPath) =>
      (ownership[configPath] === 'created') !== (baseDigests[configPath] === 'ABSENT'))) {
    throw new IntegrationStateError('integration state 引用关系无效');
  }
  const state: IntegrationState = {
    ...(value as unknown as IntegrationState),
    configFiles: [...configFiles],
    configModules: { ...value.configModules } as IntegrationState['configModules'],
    configFileOwnership: {
      ...value.configFileOwnership,
    } as IntegrationState['configFileOwnership'],
    configFileBaseDigests: {
      ...value.configFileBaseDigests,
    } as IntegrationState['configFileBaseDigests'],
    nodes: parsedNodes,
  };
  const expectedFingerprint = integrationStateFingerprint(state);
  const legacyFingerprint = legacyIntegrationStateFingerprint();
  if (state.stateFile.fingerprint !== expectedFingerprint
    && !(options.allowLegacyStateFingerprint
      && state.stateFile.fingerprint === legacyFingerprint)) {
    throw new IntegrationStateError('integration state fingerprint 无效');
  }
  return state;
}

export function readIntegrationState(
  target: CapturedTarget,
  options: { allowLegacyStateFingerprint?: boolean } = {},
): IntegrationState | null {
  if (!target.identity.exists) {
    return null;
  }
  try {
    return parseIntegrationState(JSON.parse(target.content ?? ''), options);
  } catch (error) {
    if (error instanceof IntegrationStateError) {
      throw error;
    }
    throw new IntegrationStateError('integration state 不是合法 JSON');
  }
}

export function serializeIntegrationState(state: IntegrationState): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(state)), null, 2)}\n`;
}

function isViteBrowserAccessMutation(
  operation: AstOperation,
  browserAccess: BrowserAccessMode | undefined,
): operation is AstOperation & {
  controlledMutation: NonNullable<AstOperation['controlledMutation']>;
} {
  const mutation = operation.controlledMutation;
  return operation.kind === 'plugin'
    && operation.ownership === 'reused'
    && mutation?.kind === 'vite-browser-access'
    && browserAccess !== undefined
    && mutation.targetMode === browserAccess
    && operation.details?.browserAccessMode === browserAccess
    && operation.fingerprint === mutation.targetFingerprint
    && validFingerprint(mutation.previousFingerprint)
    && validFingerprint(mutation.targetFingerprint)
    && validBrowserAccessPreviousShape(mutation.previousShape);
}

function withoutBrowserAccessDetails(
  details: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const {
    browserAccessMode: _browserAccessMode,
    browserAccessOriginalShape: _browserAccessOriginalShape,
    browserAccessOriginalFingerprint: _browserAccessOriginalFingerprint,
    ...rest
  } = details ?? {};
  return rest;
}

function mergeViteBrowserAccessDetails(
  operation: AstOperation,
  recorded: IntegrationStateNode,
): Readonly<Record<string, string>> {
  const mutation = operation.controlledMutation;
  if (!mutation || mutation.kind !== 'vite-browser-access') {
    throw new IntegrationStateError('browserAccess 受控迁移信息无效');
  }
  const recordedOriginalShape = recorded.details?.browserAccessOriginalShape;
  const recordedOriginalFingerprint = recorded.details?.browserAccessOriginalFingerprint;
  if ((recordedOriginalShape === undefined) !== (recordedOriginalFingerprint === undefined)) {
    throw new IntegrationStateError('browserAccess 原始恢复信息不完整');
  }
  const originalShape = recorded.ownership === 'reused'
    ? recordedOriginalShape ?? mutation.previousShape
    : undefined;
  const originalFingerprint = recorded.ownership === 'reused'
    ? recordedOriginalFingerprint ?? mutation.previousFingerprint
    : undefined;
  return {
    ...withoutBrowserAccessDetails(recorded.details),
    ...withoutBrowserAccessDetails(operation.details),
    browserAccessMode: mutation.targetMode,
    ...(originalShape && originalFingerprint ? {
      browserAccessOriginalShape: originalShape,
      browserAccessOriginalFingerprint: originalFingerprint,
    } : {}),
  };
}

export function preserveRecordedOwnership(
  configPath: string,
  operations: readonly AstOperation[],
  existingState: IntegrationState | null,
  options: { browserAccess?: BrowserAccessMode } = {},
): AstOperation[] {
  if (!existingState) {
    return [...operations];
  }
  const recorded = existingState.nodes.filter((node) => node.configPath === configPath);
  if (recorded.length !== operations.length) {
    throw new IntegrationStateError('配置节点数量与 integration state 不一致');
  }
  const unmatched = [...recorded];
  return operations.map((operation) => {
    if (operation.controlledMutation) {
      if (!isViteBrowserAccessMutation(operation, options.browserAccess)
        || existingState.profile.bundler !== 'vite') {
        throw new IntegrationStateError('browserAccess 受控迁移不满足安全条件');
      }
      const mutation = operation.controlledMutation;
      const matches = unmatched.filter((node) => node.kind === 'plugin'
        && node.fingerprint === mutation.previousFingerprint);
      if (matches.length !== 1) {
        throw new IntegrationStateError('browserAccess 旧 fingerprint 与 integration state 不一致');
      }
      const match = matches[0] as IntegrationStateNode;
      if (match.details?.binding !== operation.details?.binding) {
        throw new IntegrationStateError('browserAccess binding 与 integration state 不一致');
      }
      unmatched.splice(unmatched.indexOf(match), 1);
      return {
        ...operation,
        ownership: match.ownership,
        details: mergeViteBrowserAccessDetails(operation, match),
      };
    }
    if (operation.ownership === 'created') {
      throw new IntegrationStateError('已记录配置节点不能在重放时重建');
    }
    const matches = unmatched.filter((node) => node.kind === operation.kind
      && (node.fingerprint === operation.fingerprint
        || (node.fingerprint === operation.details?.legacyFingerprint
          && operation.ownership === 'reused'
          && operation.details?.legacyCreatedCompatible === 'true')));
    if (matches.length !== 1) {
      throw new IntegrationStateError('配置节点 fingerprint 与 integration state 不一致');
    }
    const match = matches[0] as IntegrationStateNode;
    unmatched.splice(unmatched.indexOf(match), 1);
    return {
      ...operation,
      ownership: match.ownership,
      details: {
        ...operation.details,
        ...match.details,
      },
    };
  });
}
