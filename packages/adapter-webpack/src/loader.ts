import { relativePathFromRoot, createSourceDigest } from '@web-source-inspector/compiler-core';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  resolveVueCompilerAdapter,
  transformVueSfc,
  type VueCompilerAdapter,
} from '@web-source-inspector/transform-vue';

import {
  clearBuildMetadata,
  writeBuildMetadata,
} from './build-metadata.js';
import {
  WSI_BUILD_METADATA_SCHEMA_VERSION,
  WSI_LOADER_OPTIONS_KEY,
  WSI_RAW_RUNTIME_QUERY_KEY,
  WSI_RUNTIME_QUERY_KEY,
} from './constants.js';
import { WebpackAdapterError } from './errors.js';
import { getWebpackAdapterSession } from './registry.js';
import { createTemplateSourceMap } from './template-source-map.js';
import { createWebpackRuntimeClientSource } from './runtime-entry.js';
import {
  isInspectableHtmlTemplateQuery,
  parseVueTemplateQuery,
} from './template-query.js';
import type {
  WebpackAdapterSession,
  WebpackLoaderCallback,
  WebpackLoaderContextLike,
  WsiBuildMetadata,
  WsiLoaderIdentity,
  WsiRuntimeBootstrapOptions,
} from './types.js';
import { assertRuntimeTemplateChain } from './vue-rule.js';

const resolvedCompilers = new WeakMap<WebpackAdapterSession, VueCompilerAdapter>();

export default function webSourceInspectorWebpackLoader(
  this: WebpackLoaderContextLike,
  source: string | Buffer,
  incomingSourceMap?: unknown,
  additionalData?: unknown,
): string | Buffer | void {
  const session = getWebpackAdapterSession(this._compiler);
  const templateQuery = session && !session.disposed
    ? parseVueTemplateQuery(this.resourceQuery, session.vueLoaderMajor)
    : null;
  if (templateQuery && !isInspectableHtmlTemplateQuery(templateQuery)) {
    clearBuildMetadata(this._module);
    return passThrough(this, source, incomingSourceMap, additionalData);
  }
  const rawRuntimeOptions = readRawRuntimePlaceholder(this);
  if (rawRuntimeOptions) {
    if (
      !session ||
      session.disposed ||
      !session.rawCredential ||
      rawRuntimeOptions.sessionId !== session.compilerSessionId ||
      rawRuntimeOptions.sessionEpoch !== session.sessionEpoch ||
      typeof rawRuntimeOptions.runtimeModuleRequest !== 'string' ||
      rawRuntimeOptions.runtimeModuleRequest.length === 0
    ) {
      throw pipelineError('raw Runtime placeholder 与活动 Plugin session 不一致');
    }
    contextDisableCache(this);
    if (!session.rawServer) {
      return 'export {};';
    }
    return createWebpackRuntimeClientSource({
      sessionId: session.compilerSessionId,
      sessionEpoch: session.sessionEpoch,
      browserToken: session.rawCredential.browserToken,
      runtimeModuleRequest: rawRuntimeOptions.runtimeModuleRequest,
      transport: {
        kind: 'raw',
        port: session.rawServer.port,
        path: session.rawCredential.basePath,
      },
    });
  }
  const runtimeOptions = readRuntimeBootstrapOptions(this);
  if (runtimeOptions) {
    if (!session || session.disposed || !session.browserCredential) {
      throw pipelineError('Runtime entry 缺少活动 development browser session');
    }
    assertRuntimeBootstrapOptions(runtimeOptions, session);
    return createWebpackRuntimeClientSource(runtimeOptions);
  }
  if (!session || session.disposed) {
    return passThrough(this, source, incomingSourceMap, additionalData);
  }
  if (!templateQuery) {
    clearBuildMetadata(this._module);
    return passThrough(this, source, incomingSourceMap, additionalData);
  }

  const callback = this.async?.();
  if (!callback) {
    throw new WebpackAdapterError(
      'TEMPLATE_PIPELINE_MISMATCH',
      'WSI template Loader 必须运行在 Webpack async loader 上下文',
    );
  }
  transformTemplate(this, session, source, incomingSourceMap, additionalData, callback);
}

interface RawRuntimePlaceholderOptions {
  sessionId: string;
  sessionEpoch: string;
  runtimeModuleRequest: string;
}

function readRawRuntimePlaceholder(
  context: WebpackLoaderContextLike,
): RawRuntimePlaceholderOptions | null {
  const encoded = readEncodedLoaderOption(context, WSI_RAW_RUNTIME_QUERY_KEY);
  if (encoded === null) {
    return null;
  }
  return decodeLoaderJsonOption<RawRuntimePlaceholderOptions>(encoded, 'raw Runtime placeholder');
}

function readRuntimeBootstrapOptions(
  context: WebpackLoaderContextLike,
): WsiRuntimeBootstrapOptions | null {
  const encoded = readEncodedLoaderOption(context, WSI_RUNTIME_QUERY_KEY);
  if (encoded === null) {
    return null;
  }
  return decodeLoaderJsonOption<WsiRuntimeBootstrapOptions>(encoded, 'Runtime entry options');
}

function readEncodedLoaderOption(
  context: WebpackLoaderContextLike,
  optionName: string,
): string | null {
  const options = context.getOptions?.() ?? context.query;
  let encoded: unknown;
  if (typeof options === 'string') {
    const query = options.startsWith('?') ? options.slice(1) : options;
    const values = new URLSearchParams(query).getAll(optionName);
    encoded = values.length === 1 ? values[0] : undefined;
  } else if (typeof options === 'object' && options !== null) {
    encoded = (options as Record<string, unknown>)[optionName];
  }
  if (encoded === undefined) {
    return null;
  }
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw pipelineError(`${optionName} 编码无效`);
  }
  return encoded;
}

function decodeLoaderJsonOption<T>(encoded: string, label: string): T {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('NOT_OBJECT');
    }
    return parsed as T;
  } catch {
    throw pipelineError(`${label} 不是有效 JSON 对象`);
  }
}

function contextDisableCache(context: WebpackLoaderContextLike): void {
  context.cacheable?.(false);
}

function assertRuntimeBootstrapOptions(
  actual: WsiRuntimeBootstrapOptions,
  session: WebpackAdapterSession,
): void {
  const credential = session.browserCredential;
  if (
    !credential ||
    actual.sessionId !== session.compilerSessionId ||
    actual.sessionEpoch !== session.sessionEpoch ||
    actual.browserToken !== credential.browserToken ||
    typeof actual.runtimeModuleRequest !== 'string' ||
    actual.runtimeModuleRequest.length === 0 ||
    actual.runtimeModuleRequest.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(actual.runtimeModuleRequest) ||
    typeof actual.transport !== 'object' ||
    actual.transport === null ||
    (actual.transport.kind !== 'wds' && actual.transport.kind !== 'raw')
  ) {
    throw pipelineError('Runtime entry options 与活动 Plugin session 不一致');
  }
  if (
    (actual.transport.kind === 'wds' &&
      (!session.wdsCredential || actual.transport.basePath !== session.wdsCredential.basePath)) ||
    (actual.transport.kind === 'raw' &&
      (!session.rawCredential ||
        !session.rawServer ||
        actual.transport.path !== session.rawCredential.basePath ||
        actual.transport.port !== session.rawServer.port))
  ) {
    throw pipelineError('Runtime transport descriptor 与活动 Plugin session 不一致');
  }
}

async function transformTemplate(
  context: WebpackLoaderContextLike,
  session: WebpackAdapterSession,
  source: string | Buffer,
  incomingSourceMap: unknown,
  additionalData: unknown,
  callback: WebpackLoaderCallback,
): Promise<void> {
  try {
    assertLoaderIdentity(readLoaderIdentity(context), session.loaderIdentity);
    const fullSource = await readFullSfc(context, session);
    const compiler = getVueCompiler(session);
    const parsedSfc = compiler.parseSfc(fullSource, context.resourcePath);
    if (parsedSfc.errors.length > 0 || parsedSfc.template === null) {
      throw pipelineError('无法从完整 SFC 确认 template block');
    }
    const template = parsedSfc.template;
    if (template.src !== undefined || (template.lang !== undefined && template.lang.toLowerCase() !== 'html')) {
      clearBuildMetadata(context._module);
      callback(null, source, incomingSourceMap, additionalData);
      return;
    }
    const incomingTemplate = typeof source === 'string' ? source : source.toString('utf8');
    if (!matchesVueLoaderSelectorOutput(incomingTemplate, template.content, compiler.family)) {
      throw pipelineError('vue-loader selector 输出与完整 SFC template 内容不一致');
    }
    const vueLoaderPath = assertRuntimeTemplateChain(
      context.loaders,
      context.loaderIndex,
      session.vueLoaderMajor,
      session.loaderIdentity.loaderPath,
    );

    const relativePath = relativePathFromRoot(session.root, context.resourcePath);
    const moduleId = relativePath;
    const fullDigest = createSourceDigest(fullSource);
    const generation = session.manifest.allocateGeneration(moduleId, fullDigest);
    const result = transformVueSfc({
      source: fullSource,
      filename: context.resourcePath,
      rootKey: session.rootKey,
      relativePath,
      moduleId,
      moduleGeneration: generation,
      compiler,
      sourceMap: false,
      createSourceId: session.createSourceId,
    });
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.severity === 'warning') {
        context.emitWarning?.(new Error(`${diagnostic.code}:${diagnostic.message}`));
      }
    }
    const errorDiagnostic = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (errorDiagnostic) {
      throw pipelineError(`${errorDiagnostic.code}:${errorDiagnostic.message}`);
    }
    const transformedSfc = compiler.parseSfc(result.code, context.resourcePath);
    if (transformedSfc.errors.length > 0 || transformedSfc.template === null) {
      throw pipelineError('无法从 Transform 结果恢复 template block');
    }
    const transformedTemplate = transformedSfc.template.content;
    const outputSourceMap = result.transformed
      ? createTemplateSourceMap(
          fullSource,
          template.startOffset,
          template.endOffset,
          template.content,
          transformedTemplate,
          relativePath,
        )
      : incomingSourceMap;
    const metadata: WsiBuildMetadata = {
      ...session.loaderIdentity,
      schemaVersion: WSI_BUILD_METADATA_SCHEMA_VERSION,
      moduleId,
      fullDigest,
      generation,
      records: result.records,
    };
    if (result.transformed) {
      disableVueLoaderTemplateAstReuse(
        context.resourcePath,
        vueLoaderPath,
        session.vueLoaderMajor,
      );
    }
    writeBuildMetadata(context._module, metadata);
    callback(null, transformedTemplate, outputSourceMap, additionalData);
  } catch (error) {
    clearBuildMetadata(context._module);
    callback(toError(error));
  }
}

function matchesVueLoaderSelectorOutput(
  incomingTemplate: string,
  rawTemplate: string,
  compilerFamily: VueCompilerAdapter['family'],
): boolean {
  if (incomingTemplate === rawTemplate) {
    return true;
  }
  return compilerFamily !== 'vue3' && incomingTemplate === deindentVue2Template(rawTemplate);
}

function deindentVue2Template(source: string): string {
  if (!/^(\r?\n)*[\t\s]/.test(source)) {
    return source;
  }
  const lines = source.split(/\r?\n/g);
  let indentationCharacter: ' ' | '\t' | null = null;
  let minimumIndentation = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (/^\s*$/.test(line)) {
      continue;
    }
    if (indentationCharacter === null) {
      const firstCharacter = line[0];
      if (firstCharacter !== ' ' && firstCharacter !== '\t') {
        return source;
      }
      indentationCharacter = firstCharacter;
    }
    let indentation = 0;
    while (line[indentation] === indentationCharacter) {
      indentation += 1;
    }
    minimumIndentation = Math.min(minimumIndentation, indentation);
  }
  if (!Number.isFinite(minimumIndentation)) {
    return lines.join('\n');
  }
  // 对齐 vue-loader 15 使用的 Vue 2 SFC de-indent 语义。
  return lines.map((line) => line.slice(minimumIndentation)).join('\n');
}

function disableVueLoaderTemplateAstReuse(
  resourcePath: string,
  vueLoaderPath: string,
  vueLoaderMajor: 15 | 16 | 17,
): void {
  if (vueLoaderMajor !== 17) {
    return;
  }
  if (!path.isAbsolute(vueLoaderPath)) {
    throw pipelineError('vue-loader 主 Loader 路径不是绝对路径');
  }
  try {
    const descriptorCacheModule = createRequire(vueLoaderPath)('./descriptorCache.js') as unknown;
    if (
      typeof descriptorCacheModule !== 'object' ||
      descriptorCacheModule === null ||
      typeof (descriptorCacheModule as { getDescriptor?: unknown }).getDescriptor !== 'function'
    ) {
      throw new Error('descriptorCache.getDescriptor 不可用');
    }
    const descriptor = (
      descriptorCacheModule as { getDescriptor(filename: string): unknown }
    ).getDescriptor(resourcePath);
    if (typeof descriptor !== 'object' || descriptor === null) {
      throw new Error('当前 SFC descriptor 不存在');
    }
    const template = (descriptor as { template?: unknown }).template;
    if (typeof template !== 'object' || template === null) {
      throw new Error('当前 SFC template descriptor 不存在');
    }
    // vue-loader 17.4+ 会复用原始 AST 并忽略修改后的 source；待上游提供禁用入口后可移除。
    (template as { ast?: unknown }).ast = undefined;
    if ((template as { ast?: unknown }).ast !== undefined) {
      throw new Error('当前 SFC template AST 无法清空');
    }
  } catch (error) {
    throw pipelineError(
      `无法禁用 vue-loader template AST 复用：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getVueCompiler(session: WebpackAdapterSession): VueCompilerAdapter {
  if (session.vueCompiler) {
    return session.vueCompiler;
  }
  const existing = resolvedCompilers.get(session);
  if (existing) {
    return existing;
  }
  const compiler = resolveVueCompilerAdapter({
    projectRoot: session.root,
    vueVersion: session.vueVersion,
  });
  resolvedCompilers.set(session, compiler);
  return compiler;
}

function readFullSfc(
  context: WebpackLoaderContextLike,
  session: WebpackAdapterSession,
): Promise<string> {
  const inputFileSystem = session.compiler.inputFileSystem ?? context.fs;
  if (!inputFileSystem) {
    return Promise.reject(pipelineError('Webpack compiler input filesystem 不可用'));
  }
  return new Promise((resolve, reject) => {
    inputFileSystem.readFile(context.resourcePath, (error, data) => {
      if (error) {
        reject(error);
        return;
      }
      if (typeof data !== 'string' && !Buffer.isBuffer(data)) {
        reject(pipelineError('Webpack input filesystem 未返回 SFC 内容'));
        return;
      }
      resolve(typeof data === 'string' ? data : data.toString('utf8'));
    });
  });
}

function readLoaderIdentity(context: WebpackLoaderContextLike): WsiLoaderIdentity | null {
  const options = context.getOptions?.() ?? context.query;
  if (typeof options !== 'object' || options === null) {
    return null;
  }
  const candidate = (options as Record<string, unknown>)[WSI_LOADER_OPTIONS_KEY];
  return typeof candidate === 'object' && candidate !== null
    ? (candidate as WsiLoaderIdentity)
    : null;
}

function assertLoaderIdentity(
  actual: WsiLoaderIdentity | null,
  expected: WsiLoaderIdentity,
): void {
  if (
    !actual ||
    actual.schemaVersion !== expected.schemaVersion ||
    actual.sessionEpoch !== expected.sessionEpoch ||
    actual.compilerSessionId !== expected.compilerSessionId ||
    actual.adapterVersion !== expected.adapterVersion ||
    actual.compilerVersion !== expected.compilerVersion ||
    actual.vueLoaderMajor !== expected.vueLoaderMajor
    || actual.loaderPath !== expected.loaderPath
  ) {
    throw pipelineError('WSI Loader cache identity 与活动 Plugin session 不一致');
  }
}

function passThrough(
  context: WebpackLoaderContextLike,
  source: string | Buffer,
  incomingSourceMap: unknown,
  additionalData: unknown,
): string | Buffer | void {
  const callback = context.async?.();
  if (callback) {
    callback(null, source, incomingSourceMap, additionalData);
    return;
  }
  return source;
}

function pipelineError(message: string): WebpackAdapterError {
  return new WebpackAdapterError('TEMPLATE_PIPELINE_MISMATCH', message);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// Webpack 应以字符串调用 normal loader，显式声明可避免 Buffer 分支污染后续链。
(webSourceInspectorWebpackLoader as typeof webSourceInspectorWebpackLoader & { raw: boolean }).raw = false;
