import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { WebpackAdapterError } from './errors.js';
import { WSI_LOADER_OPTIONS_KEY } from './constants.js';
import type {
  VueLoaderMajor,
  WebpackCompilerLike,
  WebpackLoaderEntry,
  WebpackRuleLike,
  WsiLoaderIdentity,
} from './types.js';

interface LoaderReference {
  rule: WebpackRuleLike;
  loader: string;
  options: unknown;
  replace(entry: WebpackLoaderEntry): void;
}

interface NormalizedLoaderEntry extends WebpackLoaderEntry {
  loader: string;
}

export function configureLoaderIdentity(
  compiler: WebpackCompilerLike,
  loaderPath: string,
  identity: WsiLoaderIdentity,
): { disabledLoaders: string[] } {
  const references = collectLoaderReferences(compiler.options?.module?.rules ?? []);
  const matches = references.filter((reference) => sameLoader(reference.loader, loaderPath));
  if (matches.length !== 1) {
    throw pipelineError(`最终 rules 中必须且只能有一个 WSI Loader，当前为 ${matches.length} 个`);
  }
  const match = matches[0];
  if (!match) {
    throw pipelineError('无法取得 WSI Loader 配置');
  }
  if (match.options !== undefined && !isPlainObject(match.options)) {
    throw pipelineError('WSI Loader options 必须是普通对象');
  }
  match.replace({
    loader: match.loader,
    options: {
      ...(match.options as Record<string, unknown> | undefined),
      [WSI_LOADER_OPTIONS_KEY]: identity,
    },
  });
  const disabledLoaders = disableVueLoaderPitcherCache(references);
  disabledLoaders.push(...disableDevelopmentOnlyLoaders(match.rule, loaderPath));
  disabledLoaders.push(
    ...disableVueTemplateRuleLoaders(
      compiler.options?.module?.rules ?? [],
      match.rule,
      loaderPath,
      compiler.options?.context ?? compiler.context ?? process.cwd(),
    ),
  );
  return { disabledLoaders };
}

export function validateConfiguredVuePipeline(
  compiler: WebpackCompilerLike,
  loaderPath: string,
): void {
  const references = collectLoaderReferences(compiler.options?.module?.rules ?? []);
  const wsiReferences = references.filter((reference) => sameLoader(reference.loader, loaderPath));
  if (wsiReferences.length !== 1) {
    throw pipelineError(`最终 rules 中必须且只能有一个 WSI Loader，当前为 ${wsiReferences.length} 个`);
  }
  const wsiReference = wsiReferences[0];
  if (!wsiReference) {
    throw pipelineError('无法取得 WSI Loader rule');
  }
  const sameRule = references.filter((reference) => reference.rule === wsiReference.rule);
  const wsiIndex = sameRule.indexOf(wsiReference);
  const vueLoaderIndexes = sameRule
    .map((reference, index) => (isVueLoaderMain(reference.loader) ? index : -1))
    .filter((index) => index >= 0);
  if (vueLoaderIndexes.length !== 1 || wsiIndex >= (vueLoaderIndexes[0] ?? -1)) {
    throw pipelineError('原始 Vue rule 必须保持 [WSI Loader, vue-loader] 的书写顺序');
  }
  if (sameRule.some((reference) => isThreadLoader(reference.loader))) {
    throw pipelineError('首阶段不允许 WSI Vue rule 继续由 thread-loader 执行');
  }
  if (sameRule.some((reference) => isCacheLoader(reference.loader))) {
    throw pipelineError('首阶段不允许 cache-loader 缓存 WSI template 输出');
  }

  const plugins = compiler.options?.plugins ?? [];
  if (!plugins.some(isVueLoaderPlugin)) {
    throw pipelineError('未检测到 VueLoaderPlugin，无法证明 template block loader chain');
  }
}

export function resolveVueLoaderMajor(
  compiler: WebpackCompilerLike,
  explicitMajor: VueLoaderMajor | undefined,
): VueLoaderMajor {
  if (explicitMajor !== undefined) {
    return explicitMajor;
  }
  const context = path.resolve(compiler.options?.context ?? compiler.context ?? process.cwd());
  const packageRequire = createRequire(path.join(context, 'package.json'));
  let packagePath: string;
  try {
    packagePath = packageRequire.resolve('vue-loader/package.json');
  } catch {
    throw pipelineError('无法从消费项目解析 vue-loader/package.json');
  }
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
  const version = packageJson.version;
  const match = typeof version === 'string' ? /^(\d+)\./.exec(version) : null;
  const major = match ? Number(match[1]) : Number.NaN;
  if (major !== 15 && major !== 16 && major !== 17) {
    throw pipelineError(`仅支持 vue-loader 15/16/17，检测到 ${String(version)}`);
  }
  return major;
}

export function assertRuntimeTemplateChain(
  loaders: readonly { path?: string; request?: string }[],
  loaderIndex: number,
  vueLoaderMajor: VueLoaderMajor,
  loaderPath: string,
): string {
  if (!Number.isSafeInteger(loaderIndex) || loaderIndex < 0 || loaderIndex >= loaders.length) {
    throw pipelineError('Webpack loaderIndex 无效');
  }
  const current = loaderName(loaders[loaderIndex]);
  if (!sameLoader(current, loaderPath)) {
    throw pipelineError('当前 Loader 与 Plugin 注入的 loaderPath 不一致');
  }
  if (loaders.filter((loader) => sameLoader(loaderName(loader), loaderPath)).length !== 1) {
    throw pipelineError('最终 template request 中 WSI Loader 重复');
  }
  const selector = loaderName(loaders[loaderIndex + 1]);
  if (!isVueLoaderSelector(selector, vueLoaderMajor)) {
    throw pipelineError('WSI Loader 右侧不是对应版本的 vue-loader block selector');
  }
  const hasTemplateCompiler = loaders
    .slice(0, loaderIndex)
    .some((loader) => isVueTemplateCompiler(loaderName(loader), vueLoaderMajor));
  if (!hasTemplateCompiler) {
    throw pipelineError('WSI Loader 左侧缺少对应版本的 vue-loader template compiler');
  }
  return selector;
}

function collectLoaderReferences(rules: readonly WebpackRuleLike[]): LoaderReference[] {
  const references: LoaderReference[] = [];
  for (const rule of rules) {
    collectRule(rule, references);
  }
  return references;
}

function collectRule(rule: WebpackRuleLike, references: LoaderReference[]): void {
  if (typeof rule.loader === 'string') {
    references.push({
      rule,
      loader: rule.loader,
      options: rule.options,
      replace: (entry) => {
        rule.loader = entry.loader;
        rule.options = entry.options;
      },
    });
  }
  if (Array.isArray(rule.use)) {
    rule.use.forEach((entry, index) => {
      const normalized = normalizeEntry(entry);
      if (!normalized) {
        return;
      }
      references.push({
        rule,
        loader: normalized.loader,
        options: normalized.options,
        replace: (replacement) => {
          if (Array.isArray(rule.use)) {
            rule.use[index] = replacement;
          }
        },
      });
    });
  } else {
    const normalized = normalizeEntry(rule.use);
    if (normalized) {
      references.push({
        rule,
        loader: normalized.loader,
        options: normalized.options,
        replace: (replacement) => {
          rule.use = replacement;
        },
      });
    }
  }
  for (const child of rule.rules ?? []) {
    collectRule(child, references);
  }
  for (const child of rule.oneOf ?? []) {
    collectRule(child, references);
  }
}

function normalizeEntry(
  entry: string | WebpackLoaderEntry | undefined,
): NormalizedLoaderEntry | null {
  if (typeof entry === 'string') {
    return { loader: entry };
  }
  return entry && typeof entry.loader === 'string'
    ? { ...entry, loader: entry.loader }
    : null;
}

function isVueLoaderMain(loader: string): boolean {
  const normalized = normalizeLoader(loader);
  return normalized === 'vue-loader' || /\/vue-loader\/(?:lib|dist)\/index\.js$/.test(normalized);
}

function isVueLoaderSelector(loader: string, major: VueLoaderMajor): boolean {
  const normalized = normalizeLoader(loader);
  const directory = major === 15 ? 'lib' : 'dist';
  return new RegExp(`/vue-loader/${directory}/index\\.js$`).test(normalized);
}

function isVueTemplateCompiler(loader: string, major: VueLoaderMajor): boolean {
  const normalized = normalizeLoader(loader);
  const directory = major === 15 ? 'lib/loaders' : 'dist';
  return new RegExp(`/vue-loader/${directory}/templateLoader\\.js$`).test(normalized);
}

function isThreadLoader(loader: string): boolean {
  const normalized = normalizeLoader(loader);
  return normalized === 'thread-loader' || /\/thread-loader\//.test(normalized);
}

function isCacheLoader(loader: string): boolean {
  const normalized = normalizeLoader(loader);
  return normalized === 'cache-loader' || /\/cache-loader\//.test(normalized);
}

function isVueLoaderPitcher(loader: string): boolean {
  const normalized = normalizeLoader(loader);
  return /\/vue-loader\/(?:lib\/loaders|dist)\/pitcher\.js$/.test(normalized);
}

function disableVueLoaderPitcherCache(references: readonly LoaderReference[]): string[] {
  const disabledLoaders: string[] = [];
  for (const reference of references) {
    if (!isVueLoaderPitcher(reference.loader) || !isPlainObject(reference.options)) {
      continue;
    }
    const options = { ...reference.options };
    if (options.cacheDirectory === undefined && options.cacheIdentifier === undefined) {
      continue;
    }
    delete options.cacheDirectory;
    delete options.cacheIdentifier;
    reference.replace({ loader: reference.loader, options });
    disabledLoaders.push('vue-loader-template-cache');
  }
  return disabledLoaders;
}

function disableVueTemplateRuleLoaders(
  rules: readonly WebpackRuleLike[],
  wsiRule: WebpackRuleLike,
  wsiLoaderPath: string,
  context: string,
): string[] {
  const disabledLoaders: string[] = [];
  for (const rule of rules) {
    if (rule !== wsiRule && matchesVueTemplateRequest(rule, context)) {
      disabledLoaders.push(...disableDevelopmentOnlyLoaders(rule, wsiLoaderPath));
    }
    disabledLoaders.push(
      ...disableVueTemplateRuleLoaders(rule.rules ?? [], wsiRule, wsiLoaderPath, context),
      ...disableVueTemplateRuleLoaders(rule.oneOf ?? [], wsiRule, wsiLoaderPath, context),
    );
  }
  return disabledLoaders;
}

function matchesVueTemplateRequest(rule: WebpackRuleLike, context: string): boolean {
  const resourceQuery = rule.resourceQuery;
  if (typeof resourceQuery !== 'function') {
    return false;
  }
  const resource = rule.resource;
  const probeResource = path.join(path.resolve(context), 'src', '__wsi_template_probe__.vue');
  try {
    if (typeof resource === 'function' && resource(probeResource) === false) {
      return false;
    }
    return resourceQuery('?vue&type=template&id=wsi') === true;
  } catch {
    return false;
  }
}

function disableDevelopmentOnlyLoaders(
  rule: WebpackRuleLike,
  wsiLoaderPath: string,
): string[] {
  if (!Array.isArray(rule.use)) {
    return [];
  }
  const disabledLoaders: string[] = [];
  rule.use = rule.use.filter((entry) => {
    const normalized = normalizeEntry(entry);
    if (
      !normalized ||
      sameLoader(normalized.loader, wsiLoaderPath) ||
      (!isThreadLoader(normalized.loader) && !isCacheLoader(normalized.loader))
    ) {
      return true;
    }
    disabledLoaders.push(isThreadLoader(normalized.loader) ? 'thread-loader' : 'cache-loader');
    return false;
  });
  return disabledLoaders;
}

function isVueLoaderPlugin(plugin: unknown): boolean {
  if (typeof plugin !== 'object' || plugin === null) {
    return false;
  }
  const candidate = plugin as {
    apply?: unknown;
    constructor?: { NS?: unknown };
  };
  return candidate.constructor?.NS === 'vue-loader' && typeof candidate.apply === 'function';
}

function loaderName(loader: { path?: string; request?: string } | undefined): string {
  return loader?.path ?? loader?.request?.split('?', 1)[0] ?? '';
}

function sameLoader(left: string, right: string): boolean {
  const normalizedLeft = normalizeLoader(left);
  const normalizedRight = normalizeLoader(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function normalizeLoader(loader: string): string {
  return loader.replace(/\\/g, '/').split('?', 1)[0] ?? '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pipelineError(message: string): WebpackAdapterError {
  return new WebpackAdapterError('TEMPLATE_PIPELINE_MISMATCH', message);
}
