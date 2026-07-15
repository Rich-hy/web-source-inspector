import semver from 'semver';

/** 公共运行时兼容合同；调用方不得复制这些范围。 */
export const TOOLCHAIN_COMPATIBILITY_RANGES = {
  node: '>=16.20.2',
  vite: '>=2.9.0 <7.0.0',
  webpack: '>=4.0.0 <6.0.0',
  vueCli: '>=3.0.0 <6.0.0',
  webpackDevServer: '>=3.0.0 <4.0.0 || >=4.7.0 <5.0.0',
  vue26: '>=2.6.0 <2.7.0',
  vue27: '>=2.7.0 <2.8.0',
  vue3: '>=3.2.0 <4.0.0',
  viteVue2Plugin: '>=2.0.0 <3.0.0',
  viteVue3Plugin: '>=2.0.0 <7.0.0',
  vueLoader2: '>=15.0.0 <16.0.0',
  vueLoader3: '>=16.0.0 <18.0.0',
} as const;

const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const SAFE_PACKAGE_NAME_PATTERN = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const POSIX_OR_UNC_PATH_PATTERN = /^(?:\/|\\\\)/u;
const PATH_FRAGMENT_PATTERN = /(?:^|[\\/])(?:Users|home|node_modules|\.pnpm)(?:[\\/]|$)/iu;

export type CompatibilityIssueStage =
  | 'node'
  | 'package-manager'
  | 'vue'
  | 'bundler'
  | 'companion'
  | 'compiler'
  | 'transport';

export type CompatibilityIssueSeverity = 'error' | 'warning';

export type CompatibilityIssueCode =
  | 'NODE_VERSION_MISSING'
  | 'NODE_VERSION_INVALID'
  | 'NODE_VERSION_UNSUPPORTED'
  | 'NODE_ENGINE_RANGE_INVALID'
  | 'NODE_ENGINE_UNSUPPORTED'
  | 'PACKAGE_MANAGER_UNSUPPORTED'
  | 'PACKAGE_MANAGER_UNDETERMINED'
  | 'VUE_NOT_INSTALLED'
  | 'VUE_VERSION_INVALID'
  | 'VUE_VERSION_UNSUPPORTED'
  | 'VITE_NOT_INSTALLED'
  | 'VITE_VERSION_INVALID'
  | 'VITE_VERSION_UNSUPPORTED'
  | 'WEBPACK_NOT_INSTALLED'
  | 'WEBPACK_VERSION_INVALID'
  | 'WEBPACK_VERSION_UNSUPPORTED'
  | 'VUE_CLI_NOT_INSTALLED'
  | 'VUE_CLI_VERSION_INVALID'
  | 'VUE_CLI_VERSION_UNSUPPORTED'
  | 'VITE_VUE_PLUGIN_MISSING'
  | 'VITE_VUE_PLUGIN_MISMATCH'
  | 'VITE_VUE_PLUGIN_VERSION_INVALID'
  | 'VITE_VUE_PLUGIN_VERSION_UNSUPPORTED'
  | 'VUE_LOADER_MISSING'
  | 'VUE_LOADER_VERSION_INVALID'
  | 'VUE_LOADER_VERSION_MISMATCH'
  | 'PEER_DEPENDENCY_RANGE_MISSING'
  | 'PEER_DEPENDENCY_RANGE_INVALID'
  | 'PEER_DEPENDENCY_VERSION_MISSING'
  | 'PEER_DEPENDENCY_VERSION_INVALID'
  | 'PEER_DEPENDENCY_VERSION_MISMATCH'
  | 'VUE_COMPILER_MISSING'
  | 'VUE_COMPILER_VERSION_INVALID'
  | 'VUE_COMPILER_VERSION_MISMATCH'
  | 'WDS_TRANSPORT_MISSING'
  | 'WDS_TRANSPORT_VERSION_INVALID'
  | 'WDS_TRANSPORT_UNSUPPORTED'
  | 'RAW_WATCH_ORIGIN_REQUIRED'
  | 'RAW_WATCH_ORIGIN_INVALID'
  | 'RAW_WATCH_HTTPS_UNSUPPORTED';

/**
 * 兼容性诊断只能携带稳定、可展示的值；不得放入实际 workspace 或包存储路径。
 */
export interface CompatibilityIssue {
  code: CompatibilityIssueCode;
  stage: CompatibilityIssueStage;
  severity: CompatibilityIssueSeverity;
  subject: string;
  detected: string;
  required: string;
  remediation: string;
}

/** 纯规则层需要的 package.json 已解析事实。 */
export interface PackageCompatibilityFact {
  name: string;
  version?: string;
  peerDependencies?: Readonly<Record<string, string>>;
  engines?: Readonly<{
    node?: string;
  }>;
}

export interface StrictSemVer {
  raw: string;
  normalized: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (number | string)[];
  build: readonly string[];
}

export type VueFamily = 'vue2.6' | 'vue2.7' | 'vue3';

export type VueFamilyClassification =
  | {
    status: 'supported';
    family: VueFamily;
    version: StrictSemVer;
  }
  | {
    status: 'missing' | 'invalid' | 'unsupported';
    family: undefined;
    version: undefined;
  };

export type WebpackDevServerFamily = 'wds3' | 'wds4';

export type WebpackDevServerClassification =
  | {
    status: 'supported';
    family: WebpackDevServerFamily;
    version: StrictSemVer;
  }
  | {
    status: 'missing' | 'invalid' | 'unsupported';
    family: undefined;
    version: undefined;
  };

export type PeerRangeStatus =
  | 'satisfied'
  | 'missing-range'
  | 'invalid-range'
  | 'missing-version'
  | 'invalid-version'
  | 'mismatch';

export interface PeerRangeEvaluation {
  status: PeerRangeStatus;
  range: string | undefined;
  version: StrictSemVer | undefined;
}

export type SupportedPackageManager = 'npm' | 'pnpm' | 'yarn';
export type PackageManagerKind = SupportedPackageManager | 'bun' | 'yarn-pnp' | 'unknown';
export type WebpackTransportKind = 'webpack-dev-server' | 'raw-watch' | 'none';
export type SupportedBundlerKind = 'vite' | 'webpack' | 'vue-cli';

export interface NodeCompatibilityInput {
  nodeVersion?: string;
  toolchainEngineRange?: string;
  toolchainName?: string;
}

export interface ViteCompatibilityInput {
  vite?: PackageCompatibilityFact;
  vue?: PackageCompatibilityFact;
  viteVuePlugin?: PackageCompatibilityFact;
}

export interface WebpackCompatibilityInput {
  webpack?: PackageCompatibilityFact;
  vue?: PackageCompatibilityFact;
  vueLoader?: PackageCompatibilityFact;
}

export interface VueCompilerCompatibilityInput {
  vue?: PackageCompatibilityFact;
  vueTemplateCompiler?: PackageCompatibilityFact;
  vueCompilerSfc?: PackageCompatibilityFact;
  vueCompilerDom?: PackageCompatibilityFact;
  vueCompilerSfcFromVueAnchor?: boolean;
}

export interface ToolchainCompatibilityInput {
  node?: NodeCompatibilityInput;
  packageManager?: PackageManagerKind;
  vue?: PackageCompatibilityFact;
  bundler?: SupportedBundlerKind;
  vite?: PackageCompatibilityFact;
  viteVuePlugin?: PackageCompatibilityFact;
  webpack?: PackageCompatibilityFact;
  vueCli?: PackageCompatibilityFact;
  vueLoader?: PackageCompatibilityFact;
  vueTemplateCompiler?: PackageCompatibilityFact;
  vueCompilerSfc?: PackageCompatibilityFact;
  vueCompilerDom?: PackageCompatibilityFact;
  vueCompilerSfcFromVueAnchor?: boolean;
  webpackTransport?: WebpackTransportKind;
  webpackDevServer?: PackageCompatibilityFact;
  rawWebpackOrigin?: string;
}

export interface CompatibilityIssueInput {
  code: CompatibilityIssueCode;
  stage: CompatibilityIssueStage;
  severity?: CompatibilityIssueSeverity;
  subject: string;
  detected: string | undefined;
  required: string;
  remediation: string;
}

/**
 * 只接受完整且不带宽松前缀的 SemVer，故意不使用版本截取式解析。
 */
export function parseStrictSemVer(value: unknown): StrictSemVer | undefined {
  if (typeof value !== 'string' || !STRICT_SEMVER_PATTERN.test(value)) {
    return undefined;
  }
  const parsed = semver.parse(value, { loose: false });
  if (!parsed) {
    return undefined;
  }
  return {
    raw: value,
    normalized: parsed.raw,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: [...parsed.prerelease],
    build: [...parsed.build],
  };
}

export function isStrictSemVer(value: unknown): value is string {
  return parseStrictSemVer(value) !== undefined;
}

/** SemVer range 可以使用 npm peerDependencies 合法的简写；版本本身仍必须完整。 */
export function isValidSemVerRange(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && semver.validRange(value, { loose: false }) !== null;
}

export function satisfiesStrictSemVerRange(
  version: string | undefined,
  range: string | undefined,
): boolean {
  return Boolean(
    version
      && range
      && parseStrictSemVer(version)
      && isValidSemVerRange(range)
      && semver.satisfies(version, range, { includePrerelease: false }),
  );
}

export function evaluatePeerRange(
  range: string | undefined,
  version: string | undefined,
): PeerRangeEvaluation {
  if (!range) {
    return { status: 'missing-range', range: undefined, version: parseStrictSemVer(version) };
  }
  if (!isValidSemVerRange(range)) {
    return { status: 'invalid-range', range, version: parseStrictSemVer(version) };
  }
  if (!version) {
    return { status: 'missing-version', range, version: undefined };
  }
  const parsedVersion = parseStrictSemVer(version);
  if (!parsedVersion) {
    return { status: 'invalid-version', range, version: undefined };
  }
  return {
    status: semver.satisfies(version, range, { includePrerelease: false }) ? 'satisfied' : 'mismatch',
    range,
    version: parsedVersion,
  };
}

export function classifyVueFamily(version: string | undefined): VueFamilyClassification {
  if (!version) {
    return { status: 'missing', family: undefined, version: undefined };
  }
  const parsed = parseStrictSemVer(version);
  if (!parsed) {
    return { status: 'invalid', family: undefined, version: undefined };
  }
  if (semver.satisfies(version, TOOLCHAIN_COMPATIBILITY_RANGES.vue26, { includePrerelease: false })) {
    return { status: 'supported', family: 'vue2.6', version: parsed };
  }
  if (semver.satisfies(version, TOOLCHAIN_COMPATIBILITY_RANGES.vue27, { includePrerelease: false })) {
    return { status: 'supported', family: 'vue2.7', version: parsed };
  }
  if (semver.satisfies(version, TOOLCHAIN_COMPATIBILITY_RANGES.vue3, { includePrerelease: false })) {
    return { status: 'supported', family: 'vue3', version: parsed };
  }
  return { status: 'unsupported', family: undefined, version: undefined };
}

export function classifyWebpackDevServer(
  version: string | undefined,
): WebpackDevServerClassification {
  if (!version) {
    return { status: 'missing', family: undefined, version: undefined };
  }
  const parsed = parseStrictSemVer(version);
  if (!parsed) {
    return { status: 'invalid', family: undefined, version: undefined };
  }
  if (semver.satisfies(version, '>=3.0.0 <4.0.0', { includePrerelease: false })) {
    return { status: 'supported', family: 'wds3', version: parsed };
  }
  if (semver.satisfies(version, '>=4.7.0 <5.0.0', { includePrerelease: false })) {
    return { status: 'supported', family: 'wds4', version: parsed };
  }
  return { status: 'unsupported', family: undefined, version: undefined };
}

export function expectedViteVuePlugin(
  family: VueFamily,
): { name: string; versionRange: string } {
  if (family === 'vue2.6') {
    return { name: 'vite-plugin-vue2', versionRange: TOOLCHAIN_COMPATIBILITY_RANGES.viteVue2Plugin };
  }
  if (family === 'vue2.7') {
    return { name: '@vitejs/plugin-vue2', versionRange: TOOLCHAIN_COMPATIBILITY_RANGES.viteVue2Plugin };
  }
  return { name: '@vitejs/plugin-vue', versionRange: TOOLCHAIN_COMPATIBILITY_RANGES.viteVue3Plugin };
}

/** 统一执行顺序，避免不同调用点展示同一批问题时顺序抖动。 */
export function sortCompatibilityIssues(
  issues: readonly CompatibilityIssue[],
): CompatibilityIssue[] {
  const stageOrder: Record<CompatibilityIssueStage, number> = {
    node: 0,
    'package-manager': 1,
    vue: 2,
    bundler: 3,
    companion: 4,
    compiler: 5,
    transport: 6,
  };
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((left, right) => stageOrder[left.issue.stage] - stageOrder[right.issue.stage]
      || left.index - right.index)
    .map(({ issue }) => issue);
}

export function evaluateNodeCompatibility(input: NodeCompatibilityInput): CompatibilityIssue[] {
  if (!input.nodeVersion) {
    return [createCompatibilityIssue({
      code: 'NODE_VERSION_MISSING',
      stage: 'node',
      subject: 'Node.js',
      detected: undefined,
      required: TOOLCHAIN_COMPATIBILITY_RANGES.node,
      remediation: '请安装受支持的 Node.js 版本后重试。',
    })];
  }
  const nodeVersion = parseStrictSemVer(input.nodeVersion);
  if (!nodeVersion) {
    return [createCompatibilityIssue({
      code: 'NODE_VERSION_INVALID',
      stage: 'node',
      subject: 'Node.js',
      detected: 'invalid',
      required: '完整合法的 SemVer',
      remediation: '请使用 process.versions.node 提供完整 Node.js 版本。',
    })];
  }

  const issues: CompatibilityIssue[] = [];
  if (!satisfiesStrictSemVerRange(nodeVersion.raw, TOOLCHAIN_COMPATIBILITY_RANGES.node)) {
    issues.push(createCompatibilityIssue({
      code: 'NODE_VERSION_UNSUPPORTED',
      stage: 'node',
      subject: 'Node.js',
      detected: nodeVersion.raw,
      required: TOOLCHAIN_COMPATIBILITY_RANGES.node,
      remediation: '请升级 Node.js 后重试。',
    }));
  }

  if (input.toolchainEngineRange !== undefined) {
    if (!isValidSemVerRange(input.toolchainEngineRange)) {
      issues.push(createCompatibilityIssue({
        code: 'NODE_ENGINE_RANGE_INVALID',
        stage: 'node',
        subject: `${safeToolchainName(input.toolchainName)} engines.node`,
        detected: 'invalid',
        required: '合法的 Node.js SemVer range',
        remediation: '请修正所选工具链 package.json 中的 engines.node。',
      }));
    } else if (!satisfiesStrictSemVerRange(nodeVersion.raw, input.toolchainEngineRange)) {
      issues.push(createCompatibilityIssue({
        code: 'NODE_ENGINE_UNSUPPORTED',
        stage: 'node',
        subject: `${safeToolchainName(input.toolchainName)} engines.node`,
        detected: nodeVersion.raw,
        required: input.toolchainEngineRange,
        remediation: '请切换到同时满足 Web Source Inspector 与所选工具链的 Node.js 版本。',
      }));
    }
  }
  return issues;
}

export function evaluatePackageManagerCompatibility(
  packageManager: PackageManagerKind | undefined,
): CompatibilityIssue[] {
  if (packageManager === 'bun' || packageManager === 'yarn-pnp') {
    return [createCompatibilityIssue({
      code: 'PACKAGE_MANAGER_UNSUPPORTED',
      stage: 'package-manager',
      subject: '包管理器',
      detected: packageManager,
      required: 'npm、pnpm 或 node_modules 模式 Yarn',
      remediation: '请使用受支持的 node_modules 安装模式。',
    })];
  }
  if (!packageManager || packageManager === 'unknown') {
    return [createCompatibilityIssue({
      code: 'PACKAGE_MANAGER_UNDETERMINED',
      stage: 'package-manager',
      severity: 'warning',
      subject: '包管理器',
      detected: 'unknown',
      required: 'npm、pnpm 或 node_modules 模式 Yarn',
      remediation: '请确认项目使用受支持的 node_modules 安装模式。',
    })];
  }
  return [];
}

export function evaluateVueCompatibility(
  vue: PackageCompatibilityFact | undefined,
): CompatibilityIssue[] {
  const classification = classifyVueFamily(vue?.version);
  if (classification.status === 'supported') {
    return [];
  }
  if (classification.status === 'missing') {
    return [createCompatibilityIssue({
      code: 'VUE_NOT_INSTALLED',
      stage: 'vue',
      subject: 'Vue',
      detected: undefined,
      required: `${TOOLCHAIN_COMPATIBILITY_RANGES.vue26}、${TOOLCHAIN_COMPATIBILITY_RANGES.vue27} 或 ${TOOLCHAIN_COMPATIBILITY_RANGES.vue3}`,
      remediation: '请在目标项目安装受支持的 Vue 版本。',
    })];
  }
  if (classification.status === 'invalid') {
    return [createCompatibilityIssue({
      code: 'VUE_VERSION_INVALID',
      stage: 'vue',
      subject: 'Vue',
      detected: 'invalid',
      required: '完整合法的 SemVer',
      remediation: '请修正 vue/package.json 的 version 字段。',
    })];
  }
  return [createCompatibilityIssue({
    code: 'VUE_VERSION_UNSUPPORTED',
    stage: 'vue',
    subject: 'Vue',
    detected: safeVersion(vue?.version),
    required: `${TOOLCHAIN_COMPATIBILITY_RANGES.vue26}、${TOOLCHAIN_COMPATIBILITY_RANGES.vue27} 或 ${TOOLCHAIN_COMPATIBILITY_RANGES.vue3}`,
    remediation: '请切换到受支持的 Vue 版本。',
  })];
}

export function evaluateViteCompatibility(input: ViteCompatibilityInput): CompatibilityIssue[] {
  const issues = evaluatePackageVersion(
    input.vite,
    'Vite',
    TOOLCHAIN_COMPATIBILITY_RANGES.vite,
    'VITE_NOT_INSTALLED',
    'VITE_VERSION_INVALID',
    'VITE_VERSION_UNSUPPORTED',
    'bundler',
    '请安装或切换到受支持的 Vite 版本。',
  );
  if (issues.length > 0) {
    return issues;
  }

  const vueClassification = classifyVueFamily(input.vue?.version);
  if (vueClassification.status !== 'supported') {
    return issues;
  }
  const expected = expectedViteVuePlugin(vueClassification.family);
  const plugin = input.viteVuePlugin;
  if (!plugin) {
    issues.push(createCompatibilityIssue({
      code: 'VITE_VUE_PLUGIN_MISSING',
      stage: 'companion',
      subject: 'Vite Vue plugin',
      detected: undefined,
      required: expected.name,
      remediation: `请安装与 ${vueClassification.family} 匹配的 ${expected.name}。`,
    }));
    return issues;
  }
  if (plugin.name !== expected.name) {
    issues.push(createCompatibilityIssue({
      code: 'VITE_VUE_PLUGIN_MISMATCH',
      stage: 'companion',
      subject: 'Vite Vue plugin',
      detected: safePackageName(plugin.name),
      required: expected.name,
      remediation: `请使用 ${expected.name} 作为当前 Vue 版本的 Vite plugin。`,
    }));
    return issues;
  }
  if (!plugin.version || !parseStrictSemVer(plugin.version)) {
    issues.push(createCompatibilityIssue({
      code: 'VITE_VUE_PLUGIN_VERSION_INVALID',
      stage: 'companion',
      subject: plugin.name,
      detected: safeVersion(plugin.version),
      required: expected.versionRange,
      remediation: '请使用具有完整合法 SemVer 的 Vite Vue plugin 版本。',
    }));
    return issues;
  }
  if (!satisfiesStrictSemVerRange(plugin.version, expected.versionRange)) {
    issues.push(createCompatibilityIssue({
      code: 'VITE_VUE_PLUGIN_VERSION_UNSUPPORTED',
      stage: 'companion',
      subject: plugin.name,
      detected: plugin.version,
      required: expected.versionRange,
      remediation: '请升级或降级 Vite Vue plugin 到受支持范围。',
    }));
  }
  issues.push(...evaluatePeerDependencyCompatibility(plugin, 'vite', input.vite, 'companion'));
  issues.push(...evaluatePeerDependencyCompatibility(plugin, 'vue', input.vue, 'companion'));
  return issues;
}

export function evaluateWebpackCompatibility(input: WebpackCompatibilityInput): CompatibilityIssue[] {
  const issues = evaluatePackageVersion(
    input.webpack,
    'Webpack',
    TOOLCHAIN_COMPATIBILITY_RANGES.webpack,
    'WEBPACK_NOT_INSTALLED',
    'WEBPACK_VERSION_INVALID',
    'WEBPACK_VERSION_UNSUPPORTED',
    'bundler',
    '请安装或切换到受支持的 Webpack 版本。',
  );
  if (issues.length > 0) {
    return issues;
  }

  const vueClassification = classifyVueFamily(input.vue?.version);
  if (vueClassification.status !== 'supported') {
    return issues;
  }
  const expectedRange = vueClassification.family === 'vue3'
    ? TOOLCHAIN_COMPATIBILITY_RANGES.vueLoader3
    : TOOLCHAIN_COMPATIBILITY_RANGES.vueLoader2;
  const vueLoader = input.vueLoader;
  if (!vueLoader) {
    issues.push(createCompatibilityIssue({
      code: 'VUE_LOADER_MISSING',
      stage: 'companion',
      subject: 'vue-loader',
      detected: undefined,
      required: expectedRange,
      remediation: '请安装与当前 Vue 版本匹配的 vue-loader。',
    }));
    return issues;
  }
  if (!vueLoader.version || !parseStrictSemVer(vueLoader.version)) {
    issues.push(createCompatibilityIssue({
      code: 'VUE_LOADER_VERSION_INVALID',
      stage: 'companion',
      subject: 'vue-loader',
      detected: safeVersion(vueLoader.version),
      required: expectedRange,
      remediation: '请使用具有完整合法 SemVer 的 vue-loader 版本。',
    }));
    return issues;
  }
  if (!satisfiesStrictSemVerRange(vueLoader.version, expectedRange)) {
    issues.push(createCompatibilityIssue({
      code: 'VUE_LOADER_VERSION_MISMATCH',
      stage: 'companion',
      subject: 'vue-loader',
      detected: vueLoader.version,
      required: expectedRange,
      remediation: '请使用与当前 Vue family 匹配的 vue-loader 主版本。',
    }));
  }
  issues.push(...evaluatePeerDependencyCompatibility(vueLoader, 'webpack', input.webpack, 'companion'));
  // 官方 vue-loader 15/16/17 未声明 Vue peer；Vue family 已由 loader 主版本与 compiler 版本证据约束。
  return issues;
}

export function evaluateVueCliCompatibility(
  vueCli: PackageCompatibilityFact | undefined,
): CompatibilityIssue[] {
  return evaluatePackageVersion(
    vueCli,
    'Vue CLI',
    TOOLCHAIN_COMPATIBILITY_RANGES.vueCli,
    'VUE_CLI_NOT_INSTALLED',
    'VUE_CLI_VERSION_INVALID',
    'VUE_CLI_VERSION_UNSUPPORTED',
    'bundler',
    '请安装或切换到受支持的 Vue CLI 版本。',
  );
}

export function evaluateVueCompilerCompatibility(
  input: VueCompilerCompatibilityInput,
): CompatibilityIssue[] {
  const vueClassification = classifyVueFamily(input.vue?.version);
  // Vue 本身不支持时不继续输出 compiler 级联问题。
  if (vueClassification.status !== 'supported') {
    return [];
  }
  const vueVersion = vueClassification.version.raw;
  if (vueClassification.family === 'vue2.6') {
    return evaluateExactCompilerVersion(
      input.vueTemplateCompiler,
      'vue-template-compiler',
      vueVersion,
    );
  }
  if (vueClassification.family === 'vue2.7') {
    if (input.vueCompilerSfcFromVueAnchor) {
      return [];
    }
    return [createCompatibilityIssue({
      code: 'VUE_COMPILER_MISSING',
      stage: 'compiler',
      subject: 'vue/compiler-sfc',
      detected: undefined,
      required: '必须从实际 Vue package anchor 解析',
      remediation: '请确认实际 Vue 包可解析 vue/compiler-sfc。',
    })];
  }
  return [
    ...evaluateExactCompilerVersion(input.vueCompilerSfc, '@vue/compiler-sfc', vueVersion),
    ...evaluateExactCompilerVersion(input.vueCompilerDom, '@vue/compiler-dom', vueVersion),
  ];
}

export function evaluateWebpackDevServerCompatibility(
  webpackDevServer: PackageCompatibilityFact | undefined,
): CompatibilityIssue[] {
  const classification = classifyWebpackDevServer(webpackDevServer?.version);
  if (classification.status === 'supported') {
    return [];
  }
  if (classification.status === 'missing') {
    return [createCompatibilityIssue({
      code: 'WDS_TRANSPORT_MISSING',
      stage: 'transport',
      subject: 'webpack-dev-server',
      detected: undefined,
      required: TOOLCHAIN_COMPATIBILITY_RANGES.webpackDevServer,
      remediation: '请安装受支持的 webpack-dev-server，或选择 raw Webpack watch。',
    })];
  }
  if (classification.status === 'invalid') {
    return [createCompatibilityIssue({
      code: 'WDS_TRANSPORT_VERSION_INVALID',
      stage: 'transport',
      subject: 'webpack-dev-server',
      detected: 'invalid',
      required: '完整合法的 SemVer',
      remediation: '请修正 webpack-dev-server/package.json 的 version 字段。',
    })];
  }
  return [createCompatibilityIssue({
    code: 'WDS_TRANSPORT_UNSUPPORTED',
    stage: 'transport',
    subject: 'webpack-dev-server',
    detected: safeVersion(webpackDevServer?.version),
    required: TOOLCHAIN_COMPATIBILITY_RANGES.webpackDevServer,
    remediation: '请使用 webpack-dev-server 3.x 或 >=4.7.0 <5.0.0。',
  })];
}

/** raw Webpack watch 只允许没有路径、认证信息或 HTTPS 的精确 HTTP Origin。 */
export function evaluateRawWebpackOrigin(origin: string | undefined): CompatibilityIssue[] {
  if (!origin) {
    return [createCompatibilityIssue({
      code: 'RAW_WATCH_ORIGIN_REQUIRED',
      stage: 'transport',
      subject: 'raw Webpack watch Origin',
      detected: undefined,
      required: '精确 HTTP Origin，例如 http://127.0.0.1:8080',
      remediation: '请提供页面实际使用的精确 HTTP Origin。',
    })];
  }
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') {
      return [createCompatibilityIssue({
        code: 'RAW_WATCH_HTTPS_UNSUPPORTED',
        stage: 'transport',
        subject: 'raw Webpack watch Origin',
        detected: 'https',
        required: '精确 HTTP Origin',
        remediation: '请使用 webpack-dev-server transport，或改用 HTTP raw watch Origin。',
      })];
    }
    if (url.protocol !== 'http:'
      || url.origin !== origin
      || url.username
      || url.password) {
      throw new TypeError('RAW_WATCH_ORIGIN_INVALID');
    }
    return [];
  } catch {
    return [createCompatibilityIssue({
      code: 'RAW_WATCH_ORIGIN_INVALID',
      stage: 'transport',
      subject: 'raw Webpack watch Origin',
      detected: 'invalid',
      required: '精确 HTTP Origin，例如 http://127.0.0.1:8080',
      remediation: '请移除路径、查询参数、哈希和认证信息，并使用 HTTP。',
    })];
  }
}

/**
 * 为 detect、doctor 和运行时 Adapter 提供同一批规则。调用方只传入已解析事实。
 */
export function evaluateToolchainCompatibility(
  input: ToolchainCompatibilityInput,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (input.node) {
    issues.push(...evaluateNodeCompatibility(input.node));
  }
  if (input.packageManager !== undefined) {
    issues.push(...evaluatePackageManagerCompatibility(input.packageManager));
  }
  issues.push(...evaluateVueCompatibility(input.vue));

  if (input.bundler === 'vite') {
    issues.push(...evaluateViteCompatibility({
      vite: input.vite,
      vue: input.vue,
      viteVuePlugin: input.viteVuePlugin,
    }));
  } else if (input.bundler === 'webpack') {
    issues.push(...evaluateWebpackCompatibility({
      webpack: input.webpack,
      vue: input.vue,
      vueLoader: input.vueLoader,
    }));
  } else if (input.bundler === 'vue-cli') {
    issues.push(...evaluateVueCliCompatibility(input.vueCli));
    issues.push(...evaluateWebpackCompatibility({
      webpack: input.webpack,
      vue: input.vue,
      vueLoader: input.vueLoader,
    }));
  }

  issues.push(...evaluateVueCompilerCompatibility({
    vue: input.vue,
    vueTemplateCompiler: input.vueTemplateCompiler,
    vueCompilerSfc: input.vueCompilerSfc,
    vueCompilerDom: input.vueCompilerDom,
    vueCompilerSfcFromVueAnchor: input.vueCompilerSfcFromVueAnchor,
  }));

  if (input.webpackTransport === 'webpack-dev-server') {
    issues.push(...evaluateWebpackDevServerCompatibility(input.webpackDevServer));
  } else if (input.webpackTransport === 'raw-watch') {
    issues.push(...evaluateRawWebpackOrigin(input.rawWebpackOrigin));
  }
  return sortCompatibilityIssues(issues);
}

/**
 * 统一生成可展示 issue，并过滤误传的绝对文件系统路径。
 */
export function createCompatibilityIssue(input: CompatibilityIssueInput): CompatibilityIssue {
  return {
    code: input.code,
    stage: input.stage,
    severity: input.severity ?? 'error',
    subject: redactUnsafeDiagnosticText(input.subject, 'unknown subject'),
    detected: redactUnsafeDiagnosticText(input.detected, 'unknown'),
    required: redactUnsafeDiagnosticText(input.required, 'unknown'),
    remediation: redactUnsafeDiagnosticText(input.remediation, '请检查工具链兼容性。'),
  };
}

function evaluatePackageVersion(
  packageFact: PackageCompatibilityFact | undefined,
  subject: string,
  supportedRange: string,
  missingCode: CompatibilityIssueCode,
  invalidCode: CompatibilityIssueCode,
  unsupportedCode: CompatibilityIssueCode,
  stage: CompatibilityIssueStage,
  remediation: string,
): CompatibilityIssue[] {
  if (!packageFact) {
    return [createCompatibilityIssue({
      code: missingCode,
      stage,
      subject,
      detected: undefined,
      required: supportedRange,
      remediation,
    })];
  }
  if (!packageFact.version || !parseStrictSemVer(packageFact.version)) {
    return [createCompatibilityIssue({
      code: invalidCode,
      stage,
      subject,
      detected: safeVersion(packageFact.version),
      required: '完整合法的 SemVer',
      remediation,
    })];
  }
  if (!satisfiesStrictSemVerRange(packageFact.version, supportedRange)) {
    return [createCompatibilityIssue({
      code: unsupportedCode,
      stage,
      subject,
      detected: packageFact.version,
      required: supportedRange,
      remediation,
    })];
  }
  return [];
}

function evaluatePeerDependencyCompatibility(
  owner: PackageCompatibilityFact,
  peerName: string,
  actual: PackageCompatibilityFact | undefined,
  stage: CompatibilityIssueStage,
): CompatibilityIssue[] {
  const evaluation = evaluatePeerRange(owner.peerDependencies?.[peerName], actual?.version);
  if (evaluation.status === 'satisfied') {
    return [];
  }
  const subject = `${safePackageName(owner.name)} peerDependencies.${safePackageName(peerName)}`;
  if (evaluation.status === 'missing-range') {
    return [createCompatibilityIssue({
      code: 'PEER_DEPENDENCY_RANGE_MISSING',
      stage,
      subject,
      detected: undefined,
      required: `声明 ${peerName} 的兼容范围`,
      remediation: '请使用可证明接受当前工具链版本的 companion package。',
    })];
  }
  if (evaluation.status === 'invalid-range') {
    return [createCompatibilityIssue({
      code: 'PEER_DEPENDENCY_RANGE_INVALID',
      stage,
      subject,
      detected: 'invalid',
      required: '合法的 SemVer range',
      remediation: '请修正 companion package 的 peerDependencies 声明。',
    })];
  }
  if (evaluation.status === 'missing-version') {
    return [createCompatibilityIssue({
      code: 'PEER_DEPENDENCY_VERSION_MISSING',
      stage,
      subject,
      detected: undefined,
      required: evaluation.range ?? '兼容版本',
      remediation: `请安装 ${peerName} 并确保其 version 可读取。`,
    })];
  }
  if (evaluation.status === 'invalid-version') {
    return [createCompatibilityIssue({
      code: 'PEER_DEPENDENCY_VERSION_INVALID',
      stage,
      subject,
      detected: 'invalid',
      required: evaluation.range ?? '兼容版本',
      remediation: `请修正 ${peerName}/package.json 的 version 字段。`,
    })];
  }
  return [createCompatibilityIssue({
    code: 'PEER_DEPENDENCY_VERSION_MISMATCH',
    stage,
    subject,
    detected: actual?.version,
    required: evaluation.range ?? '兼容版本',
    remediation: `请使用满足 ${safePackageName(owner.name)} peerDependencies 的 ${peerName} 版本。`,
  })];
}

function evaluateExactCompilerVersion(
  compiler: PackageCompatibilityFact | undefined,
  expectedName: string,
  vueVersion: string,
): CompatibilityIssue[] {
  if (!compiler) {
    return [createCompatibilityIssue({
      code: 'VUE_COMPILER_MISSING',
      stage: 'compiler',
      subject: expectedName,
      detected: undefined,
      required: vueVersion,
      remediation: `请安装与 Vue ${vueVersion} 完整版本一致的 ${expectedName}。`,
    })];
  }
  if (compiler.name !== expectedName || !compiler.version || !parseStrictSemVer(compiler.version)) {
    return [createCompatibilityIssue({
      code: 'VUE_COMPILER_VERSION_INVALID',
      stage: 'compiler',
      subject: expectedName,
      detected: safeVersion(compiler.version),
      required: vueVersion,
      remediation: `请使用可验证的 ${expectedName} package manifest。`,
    })];
  }
  if (compiler.version !== vueVersion) {
    return [createCompatibilityIssue({
      code: 'VUE_COMPILER_VERSION_MISMATCH',
      stage: 'compiler',
      subject: expectedName,
      detected: compiler.version,
      required: vueVersion,
      remediation: `请将 ${expectedName} 与 Vue 更新为完全相同的版本。`,
    })];
  }
  return [];
}

function safeToolchainName(value: string | undefined): string {
  return value && SAFE_PACKAGE_NAME_PATTERN.test(value)
    ? value
    : '所选工具链';
}

function safePackageName(value: string | undefined): string {
  return value && SAFE_PACKAGE_NAME_PATTERN.test(value) ? value : 'unknown package';
}

function safeVersion(value: string | undefined): string {
  return value && parseStrictSemVer(value) ? value : 'invalid';
}

function redactUnsafeDiagnosticText(value: string | undefined, fallback: string): string {
  if (!value || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)
    || POSIX_OR_UNC_PATH_PATTERN.test(value)
    || PATH_FRAGMENT_PATTERN.test(value)) {
    return fallback;
  }
  return value.length > 240 ? value.slice(0, 240) : value;
}
