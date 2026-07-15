import { createRequire } from 'node:module';
import path from 'node:path';

import { classifyVueFamily, parseStrictSemVer } from '@web-source-inspector/compiler-core';

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
  /** bundler 已确认的 Vue 版本；只能与实际 Vue 完整版本一致。 */
  vueVersion?: string;
}

interface ResolutionLoaders {
  project: NodeJS.Require;
  vue: NodeJS.Require;
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
 * 只从消费项目解析 compiler，实际 vue/package.json 是唯一版本真源。
 */
export function resolveVueCompilerAdapter(
  options: ResolveVueCompilerAdapterOptions,
): VueCompilerAdapter {
  const loaders = createResolutionLoaders(options.projectRoot);
  const vuePackage = loadOptionalModule([loaders.project], 'vue/package.json');
  const vueVersion = readPackageVersion(vuePackage);
  if (vueVersion === null) {
    throw new VueCompilerResolutionError(
      'VUE_NOT_FOUND',
      '无法从消费项目解析 vue/package.json。',
    );
  }
  if (options.vueVersion !== undefined && options.vueVersion !== vueVersion) {
    throw new VueCompilerResolutionError(
      'COMPILER_VERSION_MISMATCH',
      '传入的 Vue 版本必须与消费项目实际 vue/package.json 完全一致。',
    );
  }

  const family = classifyVueFamily(vueVersion);
  if (family.status !== 'supported') {
    throw new VueCompilerResolutionError(
      'UNSUPPORTED_VUE_VERSION',
      '当前仅支持 Vue 2.6、2.7 和 Vue 3.2 至 3.x。',
    );
  }

  if (family.family === 'vue2.6') {
    const compilerPackage = loadRequiredModule(
      [loaders.project, loaders.vue],
      'vue-template-compiler/package.json',
    );
    const compiler = loadRequiredModule(
      [loaders.project, loaders.vue],
      'vue-template-compiler',
    );
    assertCompilerPackageVersion(
      vueVersion,
      readPackageVersion(compilerPackage),
      'vue-template-compiler',
    );
    return createVue26CompilerAdapter({ compiler, version: vueVersion });
  }

  if (family.family === 'vue2.7') {
    // Vue 2.7 的 compiler 与 Vue 包同锚点解析，模块自身 version 字段不是证据。
    const compilerSfc = loadRequiredModule([loaders.vue], 'vue/compiler-sfc');
    return createVue27CompilerAdapter({ compilerSfc, version: vueVersion });
  }

  const compilerSfcPackage = loadRequiredModule(
    [loaders.vue, loaders.project],
    '@vue/compiler-sfc/package.json',
  );
  const compilerDomPackage = loadRequiredModule(
    [loaders.vue, loaders.project],
    '@vue/compiler-dom/package.json',
  );
  const compilerSfc = loadRequiredModule(
    [loaders.vue, loaders.project],
    '@vue/compiler-sfc',
  );
  const compilerDom = loadRequiredModule(
    [loaders.vue, loaders.project],
    '@vue/compiler-dom',
  );
  assertCompilerPackageVersion(
    vueVersion,
    readPackageVersion(compilerSfcPackage),
    '@vue/compiler-sfc',
  );
  assertCompilerPackageVersion(
    vueVersion,
    readPackageVersion(compilerDomPackage),
    '@vue/compiler-dom',
  );
  return createVue3CompilerAdapter({
    compilerSfc,
    compilerDom,
    version: vueVersion,
  });
}

function createResolutionLoaders(projectRoot: string): ResolutionLoaders {
  const normalizedRoot = path.resolve(projectRoot);
  const project = createRequire(path.join(normalizedRoot, 'package.json'));
  let vue: NodeJS.Require;
  try {
    // pnpm 下 compiler 可能只在 Vue 的依赖树中，必须以实际 Vue 包作为解析锚点。
    vue = createRequire(project.resolve('vue/package.json'));
  } catch {
    throw new VueCompilerResolutionError(
      'VUE_NOT_FOUND',
      '无法从消费项目解析 Vue 包。',
    );
  }
  return { project, vue };
}

function loadRequiredModule(loaders: readonly NodeJS.Require[], specifier: string): unknown {
  const loaded = loadOptionalModule(loaders, specifier);
  if (loaded === null) {
    throw new VueCompilerResolutionError(
      'COMPILER_NOT_FOUND',
      '无法从消费项目解析 ' + specifier + '；请确认实际 compiler 已安装。',
    );
  }
  return loaded;
}

function loadOptionalModule(loaders: readonly NodeJS.Require[], specifier: string): unknown | null {
  for (const loader of loaders) {
    try {
      return loader(specifier) as unknown;
    } catch (error) {
      if (isTargetModuleNotFound(error, specifier)) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

/**
 * 只有请求的目标模块本身缺失时才允许 fallback；compiler 内部缺包必须原样抛出。
 */
function isTargetModuleNotFound(error: unknown, specifier: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = error as Error & { code?: string };
  if (candidate.code !== 'MODULE_NOT_FOUND' && candidate.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return false;
  }
  return error.message.includes(specifier);
}

function readPackageVersion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('version' in value)) {
    return null;
  }
  const version = (value as { version?: unknown }).version;
  return typeof version === 'string' && parseStrictSemVer(version)
    ? version
    : null;
}

function assertCompilerPackageVersion(
  vueVersion: string,
  compilerVersion: string | null,
  compilerName: string,
): void {
  if (compilerVersion === null || compilerVersion !== vueVersion) {
    throw new VueCompilerResolutionError(
      'COMPILER_VERSION_MISMATCH',
      compilerName + ' 必须与 Vue 完全同版本。',
    );
  }
}
