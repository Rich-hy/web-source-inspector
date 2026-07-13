import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import type {
  AdapterKind,
  ConfigModuleKind,
  DetectProjectOptions,
  DetectedPackage,
  DevCommandCandidate,
  PackageManager,
  ProjectDiagnostic,
  ProjectProfile,
  RequiredInput,
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

function isWorkspacePath(workspaceRoot: string, filePath: string): boolean {
  const relative = path.relative(workspaceRoot, filePath);
  return Boolean(relative)
    && !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`);
}

function toWireRelativePath(workspaceRoot: string, filePath: string): string {
  const relative = path.relative(workspaceRoot, filePath).split(path.sep).join('/');
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('../')) {
    throw new Error('PACKAGE_PATH_OUTSIDE_WORKSPACE');
  }
  return relative;
}

function resolvePackage(
  workspaceRoot: string,
  baseManifestPath: string,
  packageName: string,
): DetectedPackage | undefined {
  const logicalPackageJsonPath = path.join(
    path.dirname(baseManifestPath),
    'node_modules',
    ...packageName.split('/'),
    'package.json',
  );
  const projectRequire = createRequire(baseManifestPath);
  let packageJsonPath: string | undefined;
  if (existsSync(logicalPackageJsonPath)) {
    // 保留 workspace 内的逻辑依赖路径，避免 pnpm Junction 泄漏物理存储绝对路径。
    packageJsonPath = logicalPackageJsonPath;
  } else {
    try {
      packageJsonPath = projectRequire.resolve(`${packageName}/package.json`);
    } catch {
      try {
        let current = path.dirname(projectRequire.resolve(packageName));
        while (path.dirname(current) !== current) {
          const candidate = path.join(current, 'package.json');
          const manifest = readJsonObject(candidate);
          if (manifest?.name === packageName) {
            packageJsonPath = candidate;
            break;
          }
          current = path.dirname(current);
        }
      } catch {
        return undefined;
      }
    }
  }
  if (!packageJsonPath || !isWorkspacePath(workspaceRoot, packageJsonPath)) {
    return undefined;
  }
  const manifest = readJsonObject(packageJsonPath);
  if (typeof manifest?.version !== 'string') {
    return undefined;
  }
  return {
    name: packageName,
    version: manifest.version,
    packageJsonPath: toWireRelativePath(workspaceRoot, packageJsonPath),
  };
}

function resolveVueCompilerSubpath(
  workspaceRoot: string,
  packageManifestPath: string,
  vue: DetectedPackage,
): DetectedPackage | undefined {
  try {
    createRequire(packageManifestPath).resolve('vue/compiler-sfc');
    return {
      name: 'vue/compiler-sfc',
      version: vue.version,
      packageJsonPath: vue.packageJsonPath,
    };
  } catch {
    return undefined;
  }
}

function detectPackageManager(workspaceRoot: string): PackageManager {
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

function diagnostic(
  diagnostics: ProjectDiagnostic[],
  code: string,
  message: string,
  blocking = true,
): void {
  diagnostics.push({ code, message, blocking, severity: blocking ? 'error' : 'warning' });
}

function sameMajorMinor(left: string, right: string): boolean {
  const leftVersion = semver.coerce(left);
  const rightVersion = semver.coerce(right);
  return Boolean(leftVersion && rightVersion
    && leftVersion.major === rightVersion.major
    && leftVersion.minor === rightVersion.minor);
}

function sameExactVersion(left: string, right: string): boolean {
  const leftVersion = semver.coerce(left);
  const rightVersion = semver.coerce(right);
  return Boolean(leftVersion && rightVersion && semver.eq(leftVersion, rightVersion));
}

function validExactOrigin(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.origin === value
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
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
  const resolve = (name: string): DetectedPackage | undefined => (
    resolvePackage(workspaceRoot, packageManifestPath, name)
  );
  const resolveFrom = (
    owner: DetectedPackage | undefined,
    name: string,
  ): DetectedPackage | undefined => {
    if (!owner) {
      return undefined;
    }
    const ownerManifest = path.resolve(workspaceRoot, owner.packageJsonPath);
    return resolvePackage(workspaceRoot, ownerManifest, name);
  };
  const vue = resolve('vue');
  const vueCliService = resolve('@vue/cli-service');
  const vite = resolve('vite');
  const webpack = resolve('webpack') ?? resolveFrom(vueCliService, 'webpack');
  const vueLoader = resolve('vue-loader') ?? resolveFrom(vueCliService, 'vue-loader');
  const webpackDevServer = resolve('webpack-dev-server')
    ?? resolveFrom(vueCliService, 'webpack-dev-server');
  const viteVue3Plugin = resolve('@vitejs/plugin-vue');
  const viteVue27Plugin = resolve('@vitejs/plugin-vue2');
  const viteVue26Plugin = resolve('vite-plugin-vue2');
  const devCommands = detectCommands(manifest.scripts);
  const configNames = [
    ...VITE_CONFIG_NAMES,
    ...WEBPACK_CONFIG_NAMES,
    'vue.config.js',
    'vue.config.cjs',
    'vue.config.mjs',
    'vue.config.ts',
  ];
  const configFiles = configNames
    .filter((fileName) => existsSync(path.join(workspaceRoot, fileName)))
    .map((fileName) => ({ path: fileName, moduleKind: moduleKind(fileName, manifest.type) }));

  const hasVite = Boolean(vite && (configFiles.some((item) => item.path.startsWith('vite.config.'))
    || devCommands.some((item) => item.bundler === 'vite')));
  const hasVueCli = Boolean(vueCliService && (configFiles.some((item) => item.path.startsWith('vue.config.'))
    || devCommands.some((item) => item.bundler === 'vue-cli')));
  const hasWebpack = Boolean(webpack && (configFiles.some((item) => item.path.startsWith('webpack.config.'))
    || devCommands.some((item) => item.bundler === 'webpack')));

  let bundler: ProjectProfile['bundler'] = 'unsupported';
  if (hasVueCli) {
    bundler = 'vue-cli';
  } else if (hasVite && hasWebpack) {
    const selected = options.answers?.bundler;
    if (selected === 'vite' || selected === 'webpack') {
      bundler = selected;
    } else {
      bundler = 'ambiguous';
      requiredInputs.push({
        questionId: 'bundler',
        type: 'choice',
        message: '检测到 Vite 与 Webpack，请选择要接入的开发入口。',
        choices: ['vite', 'webpack'],
      });
    }
  } else if (hasVite) {
    bundler = 'vite';
  } else if (hasWebpack) {
    bundler = 'webpack';
  }

  if (!vue) {
    diagnostic(diagnostics, 'VUE_NOT_INSTALLED', '未从项目解析到 Vue。');
  }
  const vueVersion = vue ? semver.coerce(vue.version) : null;
  if (vueVersion && !(
    (vueVersion.major === 2 && vueVersion.minor >= 6)
    || (vueVersion.major === 3 && vueVersion.minor >= 2)
  )) {
    diagnostic(diagnostics, 'VUE_VERSION_UNSUPPORTED', `不支持 Vue ${vue?.version ?? 'unknown'}。`);
  }

  let adapter: AdapterKind | undefined;
  let viteVuePlugin: DetectedPackage | undefined;
  let vueCompiler: DetectedPackage | undefined;
  if (vue && vueVersion) {
    if (bundler === 'vite') {
      adapter = vueVersion.major === 2 ? 'vite-vue2' : 'vite-vue3';
      if (!vite || !semver.satisfies(vite.version, '>=2 <7')) {
        diagnostic(diagnostics, 'VITE_VERSION_UNSUPPORTED', `不支持 Vite ${vite?.version ?? 'unknown'}。`);
      }
      if (vueVersion.major === 2 && vueVersion.minor === 6) {
        viteVuePlugin = viteVue26Plugin;
        vueCompiler = resolve('vue-template-compiler');
      } else if (vueVersion.major === 2) {
        viteVuePlugin = viteVue27Plugin;
        vueCompiler = resolveVueCompilerSubpath(workspaceRoot, packageManifestPath, vue);
      } else {
        viteVuePlugin = viteVue3Plugin;
        vueCompiler = resolve('@vue/compiler-sfc')
          ?? resolveVueCompilerSubpath(workspaceRoot, packageManifestPath, vue)
          ?? resolveFrom(viteVue3Plugin, '@vue/compiler-sfc');
      }
      if (!viteVuePlugin) {
        diagnostic(diagnostics, 'VITE_VUE_PLUGIN_MISSING', '未解析到与 Vue 版本匹配的 Vite Vue plugin。');
      }
    } else if (bundler === 'webpack' || bundler === 'vue-cli') {
      adapter = vueVersion.major === 2 ? 'webpack-vue2' : 'webpack-vue3';
      if (!webpack || !semver.satisfies(webpack.version, '>=4 <6')) {
        diagnostic(diagnostics, 'WEBPACK_VERSION_UNSUPPORTED', `不支持 Webpack ${webpack?.version ?? 'unknown'}。`);
      }
      const loaderMajor = vueLoader ? semver.major(semver.coerce(vueLoader.version) ?? '0.0.0') : 0;
      if (!vueLoader || (vueVersion.major === 2 ? loaderMajor !== 15 : ![16, 17].includes(loaderMajor))) {
        diagnostic(diagnostics, 'VUE_LOADER_VERSION_MISMATCH', 'vue-loader 主版本与 Vue 不匹配。');
      }
      vueCompiler = vueVersion.major === 2
        ? (vueVersion.minor === 6
          ? resolve('vue-template-compiler')
          : resolveVueCompilerSubpath(workspaceRoot, packageManifestPath, vue))
        : (resolve('@vue/compiler-sfc')
          ?? resolveVueCompilerSubpath(workspaceRoot, packageManifestPath, vue)
          ?? resolveFrom(vueLoader, '@vue/compiler-sfc'));
    }
  }

  const compilerVersionMatches = vue && vueVersion && vueCompiler
    ? (vueVersion.major === 2 && vueVersion.minor === 6
      ? sameExactVersion(vue.version, vueCompiler.version)
      : sameMajorMinor(vue.version, vueCompiler.version))
    : true;
  if (vue && vueCompiler && vueCompiler.name !== 'vue/compiler-sfc'
    && !compilerVersionMatches) {
    diagnostic(diagnostics, 'VUE_COMPILER_VERSION_MISMATCH', 'Vue 与 template compiler 版本不匹配。');
  } else if (vue && adapter && !vueCompiler) {
    diagnostic(diagnostics, 'VUE_COMPILER_MISSING', '未解析到项目实际使用的 Vue template compiler。');
  }

  if (vueCliService && !semver.satisfies(vueCliService.version, '>=3 <6')) {
    diagnostic(diagnostics, 'VUE_CLI_VERSION_UNSUPPORTED', `不支持 Vue CLI ${vueCliService.version}。`);
  }
  if (webpackDevServer) {
    const wdsVersion = semver.coerce(webpackDevServer.version);
    if (!wdsVersion || (wdsVersion.major !== 3 && !(wdsVersion.major === 4 && semver.gte(wdsVersion, '4.7.0')))) {
      diagnostic(diagnostics, 'WDS_TRANSPORT_UNSUPPORTED', `不支持 webpack-dev-server ${webpackDevServer.version}。`);
    }
  }

  if (bundler === 'vue-cli' && !webpackDevServer) {
    diagnostic(
      diagnostics,
      'WDS_TRANSPORT_UNSUPPORTED',
      'Vue CLI 项目未解析到受支持的 webpack-dev-server。',
    );
  }

  const webpackUsesDevServer = devCommands.some((item) =>
    item.bundler === 'webpack'
    && /(?:webpack-dev-server|webpack\s+serve)\b/u.test(item.command));
  const rawWebpackWatch = bundler === 'webpack' && !webpackUsesDevServer
    && devCommands.some((item) => item.bundler === 'webpack' && item.continuous);
  if (rawWebpackWatch && !validExactOrigin(options.answers?.allowedOrigin)) {
    requiredInputs.push({
      questionId: 'allowedOrigin',
      type: 'origin',
      message: '请输入 raw Webpack 页面使用的精确 HTTP(S) Origin。',
    });
  }
  if (bundler === 'unsupported') {
    diagnostic(diagnostics, 'BUNDLER_NOT_DETECTED', '未识别到支持的 Vite、Vue CLI 或 Webpack 开发入口。');
  }

  return {
    schemaVersion: 1,
    workspaceRoot: '.',
    packageManager: detectPackageManager(workspaceRoot),
    packageManifest: 'package.json',
    vue,
    vite,
    viteVuePlugin,
    webpack,
    vueCliService,
    vueLoader,
    vueCompiler,
    webpackDevServer,
    bundler,
    adapter,
    devCommands,
    configFiles,
    diagnostics,
    requiredInputs,
    blocked: requiredInputs.length > 0 || diagnostics.some((item) => item.blocking),
  };
}
