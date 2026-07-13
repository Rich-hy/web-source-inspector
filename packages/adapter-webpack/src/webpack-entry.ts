import {
  WSI_RAW_RUNTIME_QUERY_KEY,
  WSI_RUNTIME_QUERY_KEY,
} from './constants.js';
import { WebpackAdapterError } from './errors.js';
import type {
  WebpackCompilerLike,
  WebpackEntryLike,
  WebpackEntryValue,
  WsiRuntimeBootstrapOptions,
} from './types.js';

export function injectRuntimeEntry(
  compiler: WebpackCompilerLike,
  loaderPath: string,
  options: WsiRuntimeBootstrapOptions,
): void {
  if (loaderPath.includes('!')) {
    throw pipelineError('loaderPath 包含 Webpack inline request 分隔符');
  }
  const compilerOptions = compiler.options;
  if (!compilerOptions) {
    throw pipelineError('Webpack compiler options 不可用');
  }
  const entry = compilerOptions.entry;
  if (entry === undefined) {
    throw pipelineError('Webpack entry 不可用，无法注入 Inspector Runtime');
  }
  if (typeof entry === 'function') {
    throw pipelineError('首阶段不自动包装动态 Webpack entry 函数');
  }
  const runtimeRequest = createRuntimeInlineRequest(loaderPath, options);
  compilerOptions.entry = appendRuntimeRequest(entry, runtimeRequest);
}

export function injectRawRuntimePlaceholder(
  compiler: WebpackCompilerLike,
  loaderPath: string,
  options: {
    sessionId: string;
    sessionEpoch: string;
    runtimeModuleRequest: string;
  },
): void {
  if (loaderPath.includes('!')) {
    throw pipelineError('loaderPath 包含 Webpack inline request 分隔符');
  }
  const compilerOptions = compiler.options;
  const entry = compiler.options?.entry;
  if (!compilerOptions || entry === undefined || typeof entry === 'function') {
    throw pipelineError('raw watch 需要可静态修改的 Webpack entry');
  }
  const encodedOptions = Buffer.from(JSON.stringify(options), 'utf8').toString('base64url');
  const runtimeRequest = `!!${loaderPath}?${WSI_RAW_RUNTIME_QUERY_KEY}=${encodedOptions}!${loaderPath}`;
  compilerOptions.entry = appendRuntimeRequest(entry, runtimeRequest);
}

function createRuntimeInlineRequest(
  loaderPath: string,
  options: WsiRuntimeBootstrapOptions,
): string {
  if (loaderPath.includes('!')) {
    throw pipelineError('loaderPath 包含 Webpack inline request 分隔符');
  }
  const encodedOptions = Buffer.from(JSON.stringify(options), 'utf8').toString('base64url');
  return `!!${loaderPath}?${WSI_RUNTIME_QUERY_KEY}=${encodedOptions}!${loaderPath}`;
}

function appendRuntimeRequest(entry: Exclude<WebpackEntryLike, (...arguments_: unknown[]) => unknown>, request: string): WebpackEntryLike {
  if (typeof entry === 'string' || Array.isArray(entry) || isEntryDescriptor(entry)) {
    return appendEntryValue(entry, request);
  }
  const result: Record<string, WebpackEntryValue> = {};
  for (const [name, value] of Object.entries(entry)) {
    result[name] = appendEntryValue(value, request);
  }
  return result;
}

function appendEntryValue(value: WebpackEntryValue, request: string): WebpackEntryValue {
  if (typeof value === 'string') {
    return value === request ? value : [value, request];
  }
  if (Array.isArray(value)) {
    return value.includes(request) ? [...value] : [...value, request];
  }
  const imports = typeof value.import === 'string' ? [value.import] : value.import;
  return {
    ...value,
    import: imports.includes(request) ? [...imports] : [...imports, request],
  };
}

function isEntryDescriptor(value: Record<string, WebpackEntryValue> | WebpackEntryValue): value is Extract<WebpackEntryValue, object> {
  return !Array.isArray(value) && typeof value === 'object' && value !== null && 'import' in value;
}

function pipelineError(message: string): WebpackAdapterError {
  return new WebpackAdapterError('TEMPLATE_PIPELINE_MISMATCH', message);
}
