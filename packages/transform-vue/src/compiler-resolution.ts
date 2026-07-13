import { createRequire } from 'node:module';
import path from 'node:path';

import type { VueCompilerAdapter } from './common/compiler.js';
import {
  createVue26CompilerAdapter,
  createVue27CompilerAdapter,
} from './vue2/compiler-adapter.js';
import { createVue3CompilerAdapter } from './vue3/compiler-adapter.js';

export type VueCompilerResolutionErrorCode =
  | 'VUE_NOT_FOUND'
  | 'UNSUPPORTED_VUE_VERSION'
  | 'COMPILER_NOT_FOUND'
  | 'COMPILER_VERSION_MISMATCH';

export interface ResolveVueCompilerAdapterOptions {
  /** 消费项目根目录或其中任意文件所在目录。 */
  projectRoot: string;
  /** bundler 已确认的 Vue 版本；省略时读取 vue/package.json。 */
  vueVersion?: string;
}

export class VueCompilerResolutionError extends Error {
  readonly code: VueCompilerResolutionErrorCode;

  constructor(code: VueCompilerResolutionErrorCode, message: string) {
    super(message);
    this.name = 'VueCompilerResolutionError';
    this.code = code;
  }
}

/**
 * 只从消费项目解析 compiler，避免公开包自身依赖污染实际 toolchain。
 */
export function resolveVueCompilerAdapter(
  options: ResolveVueCompilerAdapterOptions,
): VueCompilerAdapter {
  const loaders = createResolutionLoaders(options.projectRoot);
  const vuePackage = loadOptionalModule(loaders, 'vue/package.json');
  const vueVersion = options.vueVersion ?? readPackageVersion(vuePackage);
  if (vueVersion === null) {
    throw new VueCompilerResolutionError(
      'VUE_NOT_FOUND',
      '无法从消费项目解析 Vue 版本；请显式注入 compiler 或传入 vueVersion',
    );
  }

  const version = parseVueVersion(vueVersion);
  if (version.major === 2 && version.minor === 6) {
    const compiler = loadRequiredModule(loaders, 'vue-template-compiler');
    assertCompilerVersion(vueVersion, readModuleVersion(compiler), 'vue-template-compiler');
    return createVue26CompilerAdapter({ compiler, version: vueVersion });
  }

  if (version.major === 2 && version.minor === 7) {
    const compilerSfc = loadRequiredModule(loaders, 'vue/compiler-sfc');
    const compilerVersion = readModuleVersion(compilerSfc);
    if (compilerVersion !== null) {
      assertCompilerVersion(vueVersion, compilerVersion, 'vue/compiler-sfc');
    }
    return createVue27CompilerAdapter({ compilerSfc, version: vueVersion });
  }

  if (version.major === 3 && version.minor >= 2) {
    const compilerSfc = loadOptionalModule(loaders, 'vue/compiler-sfc')
      ?? loadRequiredModule(loaders, '@vue/compiler-sfc');
    const compilerDom = loadRequiredModule(loaders, '@vue/compiler-dom');
    assertCompilerVersion(vueVersion, readModuleVersion(compilerSfc), '@vue/compiler-sfc');
    const compilerDomPackage = loadOptionalModule(loaders, '@vue/compiler-dom/package.json');
    const compilerDomVersion = readPackageVersion(compilerDomPackage);
    if (compilerDomVersion !== null) {
      assertCompilerVersion(vueVersion, compilerDomVersion, '@vue/compiler-dom');
    }
    return createVue3CompilerAdapter({
      compilerSfc,
      compilerDom,
      version: vueVersion,
    });
  }

  throw new VueCompilerResolutionError(
    'UNSUPPORTED_VUE_VERSION',
    `当前仅支持 Vue 2.6、2.7 和 Vue 3.2+，检测到 ${vueVersion}`,
  );
}

function createResolutionLoaders(projectRoot: string): NodeJS.Require[] {
  const normalizedRoot = path.resolve(projectRoot);
  const projectLoader = createRequire(path.join(normalizedRoot, 'package.json'));
  const loaders = [projectLoader];
  try {
    // pnpm 下 compiler 可能只存在于 Vue 自身依赖树，必须以真实 Vue 包为解析锚点。
    loaders.push(createRequire(projectLoader.resolve('vue/package.json')));
  } catch {
    // 后续统一返回 VUE_NOT_FOUND，避免在 loader 构造阶段泄漏底层解析错误。
  }
  return loaders;
}

function loadRequiredModule(loaders: readonly NodeJS.Require[], specifier: string): unknown {
  const loaded = loadOptionalModule(loaders, specifier);
  if (loaded === null) {
    throw new VueCompilerResolutionError(
      'COMPILER_NOT_FOUND',
      `无法从消费项目解析 ${specifier}；请确认 bundler 使用的 compiler 已安装并显式注入`,
    );
  }
  return loaded;
}

function loadOptionalModule(loaders: readonly NodeJS.Require[], specifier: string): unknown | null {
  for (const loader of loaders) {
    try {
      return loader(specifier) as unknown;
    } catch (error) {
      if (isModuleNotFoundFor(error, specifier)) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function isModuleNotFoundFor(error: unknown, specifier: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = error as Error & { code?: string };
  return (
    (candidate.code === 'MODULE_NOT_FOUND' || candidate.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') &&
    (candidate.message.includes(specifier) || candidate.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
  );
}

function readPackageVersion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('version' in value)) {
    return null;
  }
  const version = (value as { version?: unknown }).version;
  return typeof version === 'string' ? version : null;
}

function readModuleVersion(value: unknown): string | null {
  const directVersion = readPackageVersion(value);
  if (directVersion !== null) {
    return directVersion;
  }
  if (typeof value !== 'object' || value === null || !('default' in value)) {
    return null;
  }
  return readPackageVersion((value as { default?: unknown }).default);
}

function assertCompilerVersion(
  vueVersion: string,
  compilerVersion: string | null,
  compilerName: string,
): void {
  if (compilerVersion === null || compilerVersion !== vueVersion) {
    throw new VueCompilerResolutionError(
      'COMPILER_VERSION_MISMATCH',
      `${compilerName} 必须与 Vue 完全同版本：Vue ${vueVersion}，compiler ${compilerVersion ?? 'unknown'}`,
    );
  }
}

function parseVueVersion(version: string): { major: number; minor: number } {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(version);
  if (match === null) {
    throw new VueCompilerResolutionError(
      'UNSUPPORTED_VUE_VERSION',
      `无法识别 Vue 版本 ${version}`,
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}
