import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  canResolveProjectPackageSpecifier,
  classifyVueFamily,
  evaluateNodeCompatibility,
  evaluatePackageManagerCompatibility,
  evaluateToolchainCompatibility,
  evaluateVueCompatibility,
  expectedViteVuePlugin,
  findProjectPackageFact,
  parseStrictSemVer,
  sortCompatibilityIssues,
  type CompatibilityIssue,
  type PackageCompatibilityFact,
  type PackageManagerKind,
  type ProjectPackageAnchor,
  type ResolvedProjectPackageFact,
  type SupportedBundlerKind,
  type VueFamily as CompatibilityVueFamily,
  type WebpackTransportKind,
} from '@web-source-inspector/compiler-core';
import type {
  AdapterKind,
  ConfigModuleKind,
  DetectProjectOptions,
  DetectedPackage,
  DevCommandCandidate,
  PackageManager,
  ProjectDiagnostic,
  ProjectProfile,
  ProjectTransport,
  RequiredInput,
  VueFamily,
} from '../types';

const VITE_CONFIG_NAMES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
] as const;

const WEBPACK_CONFIG_NAMES = [
  'webpack.config.ts',
  'webpack.config.mts',
  'webpack.config.cts',
  'webpack.config.js',
  'webpack.config.mjs',
  'webpack.config.cjs',
] as const;

interface PackageManifest {
  type?: string;
  scripts?: Record<string, string>;
  packageManager?: string;
}

interface PackageResolution {
  fact?: ResolvedProjectPackageFact;
  detected?: DetectedPackage;
  anchor?: ProjectPackageAnchor;
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

function packageManagerFromField(value: unknown): PackageManager | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.split('@', 1)[0];
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    return name;
  }
  return undefined;
}

function detectPackageManager(workspaceRoot: string, manifest: PackageManifest): PackageManager {
  if (existsSync(path.join(workspaceRoot, '.pnp.cjs'))
    || existsSync(path.join(workspaceRoot, '.pnp.js'))) {
    return 'yarn-pnp';
  }
  if (existsSync(path.join(workspaceRoot, 'bun.lockb'))
    || existsSync(path.join(workspaceRoot, 'bun.lock'))) {
    return 'bun';
  }
  const declared = packageManagerFromField(manifest.packageManager);
  if (declared) {
    return declared;
  }
  if (existsSync(path.join(workspaceRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(path.join(workspaceRoot, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(path.join(workspaceRoot, 'package-lock.json'))) {
    return 'npm';
  }
  return 'unknown';
}

function moduleKind(fileName: string, packageType: string | undefined): ConfigModuleKind {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.ts' || extension === '.mts' || extension === '.cts') {
    return 'typescript';
  }
  if (extension === '.mjs') {
    return 'esm';
  }
  if (extension === '.cjs') {
    return 'commonjs';
  }
  return packageType === 'module' ? 'esm' : 'commonjs';
}

function detectCommands(scripts: Record<string, string> | undefined): DevCommandCandidate[] {
  const candidates: DevCommandCandidate[] = [];
  for (const [scriptName, command] of Object.entries(scripts ?? {})) {
    if (/\bvue-cli-service\s+serve\b/u.test(command)) {
      candidates.push({ scriptName, command, bundler: 'vue-cli', continuous: true });
    } else if (/\bvite(?:\s+serve|\s+dev)?(?:\s|$)/u.test(command)
      && !/\bvite\s+(?:build|preview)\b/u.test(command)) {
      candidates.push({ scriptName, command, bundler: 'vite', continuous: true });
    } else if (/\bwebpack(?:-dev-server|\s+serve)\b/u.test(command)) {
      candidates.push({ scriptName, command, bundler: 'webpack', continuous: true });
    } else if (/\bwebpack\b/u.test(command) && /(?:--watch|-w)(?:\s|$)/u.test(command)) {
      candidates.push({ scriptName, command, bundler: 'webpack', continuous: true });
    }
  }
  return candidates;
}

function toDetectedPackage(fact: ResolvedProjectPackageFact | undefined): DetectedPackage | undefined {
  if (!fact || typeof fact.version !== 'string') {
    return undefined;
  }
  return {
    name: fact.name,
    version: fact.version,
    packageJsonPath: fact.packageJsonPath,
  };
}

function resolvePackage(
  workspaceRoot: string,
  packageName: string,
  anchor?: ProjectPackageAnchor,
): PackageResolution {
  const fact = findProjectPackageFact(
    workspaceRoot,
    packageName,
    anchor ? { anchor } : undefined,
  );
  return {
    fact,
    detected: toDetectedPackage(fact),
    ...(fact ? { anchor: { packageJsonPath: fact.packageJsonPath } } : {}),
  };
}

function resolveFromOwners(
  workspaceRoot: string,
  packageName: string,
  owners: readonly PackageResolution[],
): PackageResolution {
  const rootResolution = resolvePackage(workspaceRoot, packageName);
  if (rootResolution.fact) {
    return rootResolution;
  }
  for (const owner of owners) {
    if (!owner.anchor) {
      continue;
    }
    const resolved = resolvePackage(workspaceRoot, packageName, owner.anchor);
    if (resolved.fact) {
      return resolved;
    }
  }
  return rootResolution;
}

function canResolveVueCompilerSubpath(
  workspaceRoot: string,
  vue: PackageResolution,
): boolean {
  return Boolean(vue.anchor
    && canResolveProjectPackageSpecifier(workspaceRoot, 'vue/compiler-sfc', {
      anchor: vue.anchor,
    }));
}

function virtualVueCompiler(
  vue: PackageResolution,
): { fact?: PackageCompatibilityFact; detected?: DetectedPackage } {
  if (!vue.fact || !vue.detected) {
    return {};
  }
  return {
    fact: {
      name: 'vue/compiler-sfc',
      version: vue.fact.version,
      peerDependencies: vue.fact.peerDependencies,
      engines: vue.fact.engines,
    },
    detected: {
      name: 'vue/compiler-sfc',
      version: vue.detected.version,
      packageJsonPath: vue.detected.packageJsonPath,
    },
  };
}

function addDiagnostic(
  diagnostics: ProjectDiagnostic[],
  code: string,
  message: string,
  blocking = true,
): void {
  diagnostics.push({
    code,
    message,
    blocking,
    severity: blocking ? 'error' : 'warning',
  });
}

function issueToDiagnostic(issue: CompatibilityIssue): ProjectDiagnostic {
  const message = issue.subject
    + '：检测到 ' + issue.detected
    + '；要求 ' + issue.required
    + '。' + issue.remediation;
  return {
    code: issue.code,
    message,
    blocking: issue.severity === 'error',
    severity: issue.severity,
  };
}

function projectVueFamily(
  family: CompatibilityVueFamily | undefined,
): VueFamily | undefined {
  if (family === 'vue2.6') {
    return 'vue-2.6';
  }
  if (family === 'vue2.7') {
    return 'vue-2.7';
  }
  if (family === 'vue3') {
    return 'vue-3';
  }
  return undefined;
}

function selectedBundler(
  candidates: SupportedBundlerKind[],
  answers: Readonly<Record<string, string>> | undefined,
  requiredInputs: RequiredInput[],
): ProjectProfile['bundler'] {
  if (candidates.length === 0) {
    return 'unsupported';
  }
  if (candidates.length === 1) {
    return candidates[0] as SupportedBundlerKind;
  }
  const requested = answers?.bundler;
  if (requested === 'vite' || requested === 'webpack' || requested === 'vue-cli') {
    if (candidates.includes(requested)) {
      return requested;
    }
  }
  requiredInputs.push({
    questionId: 'bundler',
    type: 'choice',
    message: '检测到多个开发入口，请选择要接入的 Bundler。',
    choices: [...candidates],
  });
  return 'ambiguous';
}

function selectedWebpackTransport(
  bundler: ProjectProfile['bundler'],
  devCommands: readonly DevCommandCandidate[],
  answers: Readonly<Record<string, string>> | undefined,
  requiredInputs: RequiredInput[],
): ProjectTransport {
  if (bundler === 'vite') {
    return 'vite';
  }
  if (bundler === 'vue-cli') {
    return 'wds';
  }
  if (bundler !== 'webpack') {
    return 'unknown';
  }
  const usesWds = devCommands.some((command) =>
    command.bundler === 'webpack'
    && /(?:webpack-dev-server|webpack\s+serve)\b/u.test(command.command));
  const usesRawWatch = devCommands.some((command) =>
    command.bundler === 'webpack'
    && /(?:--watch|-w)(?:\s|$)/u.test(command.command));
  if (usesWds && usesRawWatch) {
    const requested = answers?.transport;
    if (requested === 'wds' || requested === 'raw-watch') {
      return requested;
    }
    requiredInputs.push({
      questionId: 'transport',
      type: 'choice',
      message: '检测到 webpack-dev-server 和 raw watch，请选择页面使用的 transport。',
      choices: ['wds', 'raw-watch'],
    });
    return 'ambiguous';
  }
  if (usesWds) {
    return 'wds';
  }
  if (usesRawWatch) {
    return 'raw-watch';
  }
  return 'unknown';
}

function compilerResolution(
  workspaceRoot: string,
  vue: PackageResolution,
  family: CompatibilityVueFamily | undefined,
  owners: readonly PackageResolution[],
): {
  vueTemplateCompiler: PackageResolution;
  vueCompilerSfc: PackageResolution;
  vueCompilerDom: PackageResolution;
  vueCompilerSfcFromVueAnchor: boolean;
  primary?: DetectedPackage;
  dom?: DetectedPackage;
} {
  const vueTemplateCompiler = resolvePackage(workspaceRoot, 'vue-template-compiler');
  const vueCompilerSfc = resolveFromOwners(workspaceRoot, '@vue/compiler-sfc', owners);
  const vueCompilerDom = resolveFromOwners(workspaceRoot, '@vue/compiler-dom', owners);
  const vueCompilerSfcFromVueAnchor = family === 'vue2.7'
    && canResolveVueCompilerSubpath(workspaceRoot, vue);
  const virtualSfc = vueCompilerSfcFromVueAnchor ? virtualVueCompiler(vue) : {};
  const primary = family === 'vue2.6'
    ? vueTemplateCompiler.detected
    : family === 'vue2.7'
      ? virtualSfc.detected
      : vueCompilerSfc.detected;
  return {
    vueTemplateCompiler,
    vueCompilerSfc,
    vueCompilerDom,
    vueCompilerSfcFromVueAnchor,
    primary,
    dom: family === 'vue3' ? vueCompilerDom.detected : undefined,
  };
}

function configFiles(workspaceRoot: string, packageType: string | undefined): ProjectProfile['configFiles'] {
  const names = [
    ...VITE_CONFIG_NAMES,
    ...WEBPACK_CONFIG_NAMES,
    'vue.config.js',
    'vue.config.cjs',
    'vue.config.mjs',
    'vue.config.ts',
  ];
  return names
    .filter((fileName) => existsSync(path.join(workspaceRoot, fileName)))
    .map((fileName) => ({ path: fileName, moduleKind: moduleKind(fileName, packageType) }));
}

function engineFactForBundler(
  bundler: ProjectProfile['bundler'],
  vite: PackageResolution,
  webpack: PackageResolution,
  vueCli: PackageResolution,
): PackageResolution | undefined {
  if (bundler === 'vite') {
    return vite;
  }
  if (bundler === 'webpack') {
    return webpack;
  }
  if (bundler === 'vue-cli') {
    return vueCli;
  }
  return undefined;
}

function transportForEvaluator(transport: ProjectTransport): WebpackTransportKind {
  if (transport === 'wds') {
    return 'webpack-dev-server';
  }
  if (transport === 'raw-watch') {
    return 'raw-watch';
  }
  return 'none';
}

export function detectProject(options: DetectProjectOptions): ProjectProfile {
  const workspaceRoot = realpathSync(options.workspaceRoot);
  const packageManifestPath = path.join(workspaceRoot, 'package.json');
  const rawManifest = readJsonObject(packageManifestPath);
  if (!rawManifest) {
    throw new Error('PACKAGE_MANIFEST_INVALID');
  }
  const manifest = rawManifest as PackageManifest;
  const diagnostics: ProjectDiagnostic[] = [];
  const requiredInputs: RequiredInput[] = [];
  const packageManager = detectPackageManager(workspaceRoot, manifest);

  const vue = resolvePackage(workspaceRoot, 'vue');
  const vueCliService = resolvePackage(workspaceRoot, '@vue/cli-service');
  const vite = resolvePackage(workspaceRoot, 'vite');
  const webpack = resolveFromOwners(workspaceRoot, 'webpack', [vueCliService]);
  const vueLoader = resolveFromOwners(workspaceRoot, 'vue-loader', [vueCliService]);
  const webpackDevServer = resolveFromOwners(workspaceRoot, 'webpack-dev-server', [vueCliService]);
  const viteVue3Plugin = resolvePackage(workspaceRoot, '@vitejs/plugin-vue');
  const viteVue27Plugin = resolvePackage(workspaceRoot, '@vitejs/plugin-vue2');
  const viteVue26Plugin = resolvePackage(workspaceRoot, 'vite-plugin-vue2');
  const devCommands = detectCommands(manifest.scripts);
  const detectedConfigFiles = configFiles(workspaceRoot, manifest.type);

  const candidates: SupportedBundlerKind[] = [];
  if (vite.fact && (detectedConfigFiles.some((item) => item.path.startsWith('vite.config.'))
    || devCommands.some((item) => item.bundler === 'vite'))) {
    candidates.push('vite');
  }
  if (webpack.fact && (detectedConfigFiles.some((item) => item.path.startsWith('webpack.config.'))
    || devCommands.some((item) => item.bundler === 'webpack'))) {
    candidates.push('webpack');
  }
  if (vueCliService.fact && (detectedConfigFiles.some((item) => item.path.startsWith('vue.config.'))
    || devCommands.some((item) => item.bundler === 'vue-cli'))) {
    candidates.push('vue-cli');
  }
  const bundler = selectedBundler(candidates, options.answers, requiredInputs);
  const transport = selectedWebpackTransport(bundler, devCommands, options.answers, requiredInputs);
  if (bundler === 'webpack' && transport === 'unknown') {
    addDiagnostic(
      diagnostics,
      'WEBPACK_TRANSPORT_AMBIGUOUS',
      '未能从开发脚本证明 Webpack 页面使用 webpack-dev-server 或 raw watch。',
    );
  }
  if (transport === 'raw-watch' && options.answers?.allowedOrigin === undefined) {
    requiredInputs.push({
      questionId: 'allowedOrigin',
      type: 'origin',
      message: '请输入 raw Webpack 页面使用的精确 HTTP Origin。',
    });
  }

  const vueClassification = classifyVueFamily(vue.fact?.version);
  const expectedPlugin = vueClassification.status === 'supported'
    ? expectedViteVuePlugin(vueClassification.family)
    : undefined;
  const viteVuePlugin = expectedPlugin?.name === '@vitejs/plugin-vue'
    ? viteVue3Plugin
    : expectedPlugin?.name === '@vitejs/plugin-vue2'
      ? viteVue27Plugin
      : expectedPlugin?.name === 'vite-plugin-vue2'
        ? viteVue26Plugin
        : {};
  const compiler = compilerResolution(
    workspaceRoot,
    vue,
    vueClassification.status === 'supported' ? vueClassification.family : undefined,
    [viteVuePlugin, vueLoader],
  );

  let adapter: AdapterKind | undefined;
  if (vueClassification.status === 'supported'
    && (bundler === 'vite' || bundler === 'webpack' || bundler === 'vue-cli')) {
    adapter = bundler === 'vite'
      ? (vueClassification.family === 'vue3' ? 'vite-vue3' : 'vite-vue2')
      : (vueClassification.family === 'vue3' ? 'webpack-vue3' : 'webpack-vue2');
  }

  const engineOwner = engineFactForBundler(bundler, vite, webpack, vueCliService);
  const compatibilityIssues = bundler === 'vite' || bundler === 'webpack' || bundler === 'vue-cli'
    ? evaluateToolchainCompatibility({
      node: {
        nodeVersion: process.versions.node,
        toolchainEngineRange: engineOwner?.fact?.engines.node,
        toolchainName: engineOwner?.fact?.name,
      },
      packageManager: packageManager as PackageManagerKind,
      vue: vue.fact,
      bundler,
      vite: vite.fact,
      viteVuePlugin: viteVuePlugin.fact,
      webpack: webpack.fact,
      vueCli: vueCliService.fact,
      vueLoader: vueLoader.fact,
      vueTemplateCompiler: compiler.vueTemplateCompiler.fact,
      vueCompilerSfc: compiler.vueCompilerSfc.fact,
      vueCompilerDom: compiler.vueCompilerDom.fact,
      vueCompilerSfcFromVueAnchor: compiler.vueCompilerSfcFromVueAnchor,
      webpackTransport: transportForEvaluator(transport),
      webpackDevServer: webpackDevServer.fact,
      rawWebpackOrigin: options.answers?.allowedOrigin,
    })
    : sortCompatibilityIssues([
      ...evaluateNodeCompatibility({ nodeVersion: process.versions.node }),
      ...evaluatePackageManagerCompatibility(packageManager as PackageManagerKind),
      ...evaluateVueCompatibility(vue.fact),
    ]);
  diagnostics.push(...compatibilityIssues.map(issueToDiagnostic));
  if (bundler === 'unsupported') {
    addDiagnostic(
      diagnostics,
      'BUNDLER_NOT_DETECTED',
      '未识别到支持的 Vite、Webpack 或 Vue CLI 开发入口。',
    );
  }

  const viteVersion = parseStrictSemVer(vite.fact?.version);
  const webpackVersion = parseStrictSemVer(webpack.fact?.version);
  const vueLoaderVersion = parseStrictSemVer(vueLoader.fact?.version);
  const wdsVersion = parseStrictSemVer(webpackDevServer.fact?.version);
  return {
    schemaVersion: 1,
    workspaceRoot: '.',
    packageManager,
    packageManifest: 'package.json',
    vue: vue.detected,
    vite: vite.detected,
    viteVuePlugin: viteVuePlugin.detected,
    webpack: webpack.detected,
    vueCliService: vueCliService.detected,
    vueLoader: vueLoader.detected,
    vueCompiler: compiler.primary,
    vueCompilerDom: compiler.dom,
    webpackDevServer: webpackDevServer.detected,
    toolchain: {
      ...(projectVueFamily(
        vueClassification.status === 'supported' ? vueClassification.family : undefined,
      ) ? {
        vueFamily: projectVueFamily(
          vueClassification.status === 'supported' ? vueClassification.family : undefined,
        ),
      } : {}),
      ...(viteVersion ? { viteMajor: viteVersion.major } : {}),
      ...(vueLoaderVersion ? { vueLoaderMajor: vueLoaderVersion.major } : {}),
      ...(wdsVersion ? { webpackDevServerMajor: wdsVersion.major } : {}),
      transport,
    },
    bundler,
    adapter,
    devCommands,
    configFiles: detectedConfigFiles,
    diagnostics,
    requiredInputs,
    blocked: requiredInputs.length > 0 || diagnostics.some((item) => item.blocking),
  };
}
