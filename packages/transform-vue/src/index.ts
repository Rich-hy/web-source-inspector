import path from 'node:path';

import {
  SourceIdCollisionError,
  createLocalSnippetDigest,
  createSourceDigest,
  type ControlFlowSource,
  type SourceIdGenerator,
  type SourceIdInput,
  type SourceNodeKind,
  type SourceRange,
  type SourceRecord,
} from '@web-source-inspector/compiler-core';
import {
  PROTOCOL_LIMITS,
  isSourceId,
} from '@web-source-inspector/protocol';
import MagicString, { type SourceMap } from 'magic-string';

import {
  toErrorMessage,
  type VueCompilerAdapter,
  type VueCompilerParseError,
  type VueTemplateElementNode,
  type VueTemplateNode,
} from './common/compiler.js';
import { resolveVueCompilerAdapter } from './compiler-resolution.js';

export type {
  VueCompilerAdapter,
  VueCompilerFamily,
  VueCompilerParseError,
  VueSfcParseResult,
  VueSfcTemplateBlock,
  VueTemplateElementNode,
  VueTemplateNode,
  VueTemplateParseResult,
} from './common/compiler.js';
export {
  VueCompilerResolutionError,
  resolveVueCompilerAdapter,
  type ResolveVueCompilerAdapterOptions,
  type VueCompilerResolutionErrorCode,
} from './compiler-resolution.js';
export {
  createVue26CompilerAdapter,
  createVue27CompilerAdapter,
  type CreateVue26CompilerAdapterOptions,
  type CreateVue27CompilerAdapterOptions,
} from './vue2/compiler-adapter.js';
export {
  createVue3CompilerAdapter,
  type CreateVue3CompilerAdapterOptions,
} from './vue3/compiler-adapter.js';

export const SOURCE_ATTRIBUTE = 'data-wsi-source';
export const COMPONENT_SOURCE_ATTRIBUTE = 'data-wsi-component-source';

// 兼容当前进程可能仍加载阶段 0 前的 protocol dist；全量重建后仍与协议常量一致。
const FULL_SOURCE_ID_LENGTH = PROTOCOL_LIMITS.sourceIdLength ?? 43;

export type VueSourceKind = Extract<
  SourceNodeKind,
  'element' | 'component' | 'fragment' | 'slot' | 'dynamic'
>;

export type VueControlFlowKind = 'for' | 'if' | 'else-if' | 'else';

export type VueSourceRange = SourceRange;

export type VueControlFlow = ControlFlowSource;

export type VueSourceIdInput = SourceIdInput;

export type VueSourceRecord = SourceRecord;

export type VueTransformDiagnosticCode =
  | 'SFC_PARSE_ERROR'
  | 'TEMPLATE_PARSE_ERROR'
  | 'NO_TEMPLATE'
  | 'UNSUPPORTED_TEMPLATE_LANG'
  | 'EXTERNAL_TEMPLATE_UNSUPPORTED'
  | 'COMPILER_RESOLUTION_ERROR'
  | 'COMPILER_ADAPTER_ERROR'
  | 'RESERVED_ATTRIBUTE_CONFLICT'
  | 'SOURCE_ID_COLLISION'
  | 'SOURCE_ID_ERROR'
  | 'RECORD_FINALIZATION_ERROR';

export interface VueTransformDiagnostic {
  code: VueTransformDiagnosticCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  range: VueSourceRange | null;
}

export interface TransformVueSfcOptions {
  source: string;
  filename: string;
  rootKey: string;
  /** workspace 相对路径；转换结果会统一使用 POSIX 分隔符。 */
  relativePath: string;
  moduleId: string;
  moduleGeneration?: number;
  componentName?: string | null;
  sourceMap?: boolean;
  /** 优先注入消费项目 bundler 实际使用的 compiler adapter。 */
  compiler?: VueCompilerAdapter;
  /** 未显式注入时，从该目录优先解析消费项目 compiler。 */
  compilerRoot?: string;
  /** bundler 已确认的 Vue 版本，可避免从 package.json 二次推断。 */
  vueVersion?: string;
  createSourceId: SourceIdGenerator;
  finalizeRecords?: (
    records: readonly VueSourceRecord[],
  ) => readonly VueSourceRecord[];
}

export interface TransformVueSfcResult {
  code: string;
  map: SourceMap | null;
  records: VueSourceRecord[];
  moduleId: string;
  diagnostics: VueTransformDiagnostic[];
  transformed: boolean;
}

interface LineIndex {
  starts: number[];
  sourceLength: number;
}

interface TraversalContext {
  parentSourceId: string | null;
  controlFlow: VueControlFlow | null;
}

interface TransformState {
  options: Required<Pick<TransformVueSfcOptions, 'moduleGeneration'>> &
    Omit<TransformVueSfcOptions, 'moduleGeneration'>;
  templateOffset: number;
  lineIndex: LineIndex;
  sourceDigest: string;
  records: VueSourceRecord[];
  markerInsertions: Array<{
    offset: number;
    attributeName: string;
    recordIndex: number;
  }>;
  sourceIds: Set<string>;
  diagnostics: VueTransformDiagnostic[];
}

class LocalSourceIdCollisionError extends Error {
  readonly range: VueSourceRange;

  constructor(sourceId: string, range: VueSourceRange) {
    super(`模块内不同源码节点生成了相同 sourceId：${sourceId}`);
    this.name = 'LocalSourceIdCollisionError';
    this.range = range;
  }
}

/**
 * 将 Vue SFC 模板节点转换为服务端 manifest 记录，并只给可落到 DOM 的节点注入标识。
 */
export function transformVueSfc(options: TransformVueSfcOptions): TransformVueSfcResult {
  const normalizedOptions: TransformState['options'] = {
    ...options,
    relativePath: normalizeRelativePathSeparators(options.relativePath),
    moduleGeneration: options.moduleGeneration ?? 0,
  };
  const diagnostics: VueTransformDiagnostic[] = [];
  let compiler: VueCompilerAdapter;
  try {
    compiler =
      options.compiler ??
      resolveVueCompilerAdapter({
        projectRoot: options.compilerRoot ?? path.dirname(options.filename),
        vueVersion: options.vueVersion,
      });
  } catch (error) {
    diagnostics.push({
      code: 'COMPILER_RESOLUTION_ERROR',
      severity: 'error',
      message: `无法解析 Vue compiler：${toErrorMessage(error)}`,
      range: null,
    });
    return createUnchangedResult(normalizedOptions, diagnostics);
  }

  let sfcResult;
  try {
    sfcResult = compiler.parseSfc(options.source, options.filename);
  } catch (error) {
    diagnostics.push({
      code: 'COMPILER_ADAPTER_ERROR',
      severity: 'error',
      message: `Vue ${compiler.family} SFC adapter 失败：${toErrorMessage(error)}`,
      range: null,
    });
    return createUnchangedResult(normalizedOptions, diagnostics);
  }

  if (sfcResult.errors.length > 0) {
    diagnostics.push(
      ...sfcResult.errors.map((error) =>
        createParserDiagnostic(
          'SFC_PARSE_ERROR',
          'error',
          error,
          createLineIndex(options.source),
          0,
        ),
      ),
    );
    return createUnchangedResult(normalizedOptions, diagnostics);
  }

  const template = sfcResult.template;
  if (template === null) {
    diagnostics.push({
      code: 'NO_TEMPLATE',
      severity: 'info',
      message: '该 Vue SFC 没有 <template>，未生成 DOM 源码记录。',
      range: null,
    });
    return createFinalizedEmptyResult(normalizedOptions, diagnostics);
  }

  if (template.src !== undefined) {
    diagnostics.push({
      code: 'EXTERNAL_TEMPLATE_UNSUPPORTED',
      severity: 'warning',
      message: '首版不支持带 src 的外部 Vue template。',
      range: null,
    });
    return createFinalizedEmptyResult(normalizedOptions, diagnostics);
  }

  if (template.lang !== undefined && template.lang.toLowerCase() !== 'html') {
    diagnostics.push({
      code: 'UNSUPPORTED_TEMPLATE_LANG',
      severity: 'warning',
      message: `首版只支持 HTML template，当前 lang 为 ${template.lang}。`,
      range: null,
    });
    return createFinalizedEmptyResult(normalizedOptions, diagnostics);
  }

  const lineIndex = createLineIndex(options.source);
  const templateOffset = template.startOffset;
  let templateResult;
  try {
    templateResult = compiler.parseTemplate(template.content, options.filename);
  } catch (error) {
    diagnostics.push({
      code: 'COMPILER_ADAPTER_ERROR',
      severity: 'error',
      message: `Vue ${compiler.family} template adapter 失败：${toErrorMessage(error)}`,
      range: null,
    });
    return createUnchangedResult(normalizedOptions, diagnostics);
  }

  if (templateResult.errors.length > 0) {
    diagnostics.push(
      ...templateResult.errors.map((error) =>
        createParserDiagnostic(
          'TEMPLATE_PARSE_ERROR',
          'error',
          error,
          lineIndex,
          templateOffset,
        ),
      ),
    );
    return createUnchangedResult(normalizedOptions, diagnostics);
  }

  const state: TransformState = {
    options: normalizedOptions,
    templateOffset,
    lineIndex,
    sourceDigest: createSourceDigest(options.source),
    records: [],
    markerInsertions: [],
    sourceIds: new Set<string>(),
    diagnostics,
  };

  try {
    const meaningfulChildren = templateResult.children.filter(isMeaningfulRootChild);
    let rootContext: TraversalContext = {
      parentSourceId: null,
      controlFlow: null,
    };

    // 多根 SFC 没有实际根 DOM，保留虚拟 Fragment 供候选链向上解析。
    if (compiler.family === 'vue3' && meaningfulChildren.length > 1) {
      const firstChild = meaningfulChildren[0];
      const lastChild = meaningfulChildren.at(-1);
      if (firstChild !== undefined && lastChild !== undefined) {
        const fragmentRange = toAbsoluteRange(
          firstChild.startOffset,
          lastChild.endOffset,
          state,
        );
        const fragmentRecord = createRecord('#fragment', 'fragment', fragmentRange, rootContext, state);
        rootContext = {
          ...rootContext,
          parentSourceId: fragmentRecord.sourceId,
        };
      }
    }

    for (const child of templateResult.children) {
      visitTemplateChild(child, rootContext, state);
    }
  } catch (error) {
    if (error instanceof LocalSourceIdCollisionError) {
      diagnostics.push({
        code: 'SOURCE_ID_COLLISION',
        severity: 'error',
        message: error.message,
        range: error.range,
      });
      return createUnchangedResult(normalizedOptions, diagnostics);
    }
    diagnostics.push({
      code: 'SOURCE_ID_ERROR',
      severity: 'error',
      message: `无法生成 Vue sourceId：${toErrorMessage(error)}`,
      range: null,
    });
    return createUnchangedResult(normalizedOptions, diagnostics);
  }

  let finalizedRecords: VueSourceRecord[];
  try {
    finalizedRecords = finalizeRecords(state.records, state.options.finalizeRecords);
  } catch (error) {
    if (error instanceof SourceIdCollisionError) {
      diagnostics.push({
        code: 'SOURCE_ID_COLLISION',
        severity: 'error',
        message: error.message,
        range: error.conflictingRecord.range,
      });
      return createUnchangedResult(normalizedOptions, diagnostics);
    }
    diagnostics.push({
      code: 'RECORD_FINALIZATION_ERROR',
      severity: 'error',
      message: `无法提交 Vue source records：${toErrorMessage(error)}`,
      range: null,
    });
    return createUnchangedResult(normalizedOptions, diagnostics);
  }

  const magicString = new MagicString(options.source);
  for (const insertion of state.markerInsertions) {
    const record = finalizedRecords[insertion.recordIndex];
    if (record === undefined) {
      throw new Error('finalizeRecords 返回结果与 marker 索引不一致');
    }
    magicString.appendLeft(
      insertion.offset,
      ` ${insertion.attributeName}="${escapeHtmlAttribute(record.sourceId)}"`,
    );
  }

  return {
    code: magicString.toString(),
    map: createSourceMap(magicString, normalizedOptions),
    records: finalizedRecords,
    moduleId: options.moduleId,
    diagnostics,
    transformed: state.markerInsertions.length > 0,
  };
}

function visitTemplateChild(
  node: VueTemplateNode,
  context: TraversalContext,
  state: TransformState,
): void {
  if (node.type !== 'element') {
    return;
  }

  visitElement(node, context, state);
}

function visitElement(
  node: VueTemplateElementNode,
  context: TraversalContext,
  state: TransformState,
): void {
  const range = toAbsoluteRange(node.startOffset, node.endOffset, state);
  const controlFlow = getControlFlow(node, range) ?? context.controlFlow;
  const record = createRecord(
    node.tagName,
    node.sourceKind,
    range,
    {
      ...context,
      controlFlow,
    },
    state,
  );

  const markerAttribute = getMarkerAttribute(node);
  if (markerAttribute !== null) {
    if (hasReservedAttribute(node, markerAttribute)) {
      state.diagnostics.push({
        code: 'RESERVED_ATTRIBUTE_CONFLICT',
        severity: 'warning',
        message: `模板节点已使用保留属性 ${markerAttribute}，该节点不会重复注入标识。`,
        range,
      });
    } else {
      const insertionOffset = findOpeningTagInsertionOffset(node, state);
      state.markerInsertions.push({
        offset: insertionOffset,
        attributeName: markerAttribute,
        recordIndex: state.records.length - 1,
      });
    }
  }

  const childContext: TraversalContext = {
    parentSourceId: record.sourceId,
    controlFlow,
  };

  for (const child of node.children) {
    visitTemplateChild(child, childContext, state);
  }
}

function createRecord(
  tagName: string,
  kind: VueSourceKind,
  range: VueSourceRange,
  context: TraversalContext,
  state: TransformState,
): VueSourceRecord {
  const sourceIdInput: VueSourceIdInput = {
    normalizedRelativePath: state.options.relativePath,
    moduleGeneration: state.options.moduleGeneration,
    nodeKind: kind,
    tagName,
    range,
    startOffset: range.startOffset,
    endOffset: range.endOffset,
    localSnippetDigest: createLocalSnippetDigest(
      state.options.source,
      range.startOffset,
      range.endOffset,
    ),
  };
  const generatedSourceId = state.options.createSourceId(sourceIdInput);

  if (!isFullSourceId(generatedSourceId)) {
    throw new Error(
      `sourceId 生成器必须返回完整 ${FULL_SOURCE_ID_LENGTH} 个 Base64URL 字符`,
    );
  }
  const sourceId = registerLocalSourceId(generatedSourceId, range, state);

  const record: VueSourceRecord = {
    sourceId,
    rootKey: state.options.rootKey,
    relativePath: state.options.relativePath,
    framework: 'vue',
    kind,
    tagName,
    range,
    componentName:
      state.options.componentName === undefined
        ? inferComponentName(state.options.filename)
        : state.options.componentName,
    controlFlow: context.controlFlow,
    parentSourceId: context.parentSourceId,
    sourceDigest: state.sourceDigest,
    contextBefore: getContextBefore(state.options.source, range.startOffset),
    contextAfter: getContextAfter(state.options.source, range.endOffset),
    moduleId: state.options.moduleId,
    generation: state.options.moduleGeneration,
    accuracy: kind === 'component' || kind === 'dynamic' ? 'approximate' : 'exact',
  };
  state.records.push(record);
  return record;
}

function registerLocalSourceId(
  sourceId: string,
  range: VueSourceRange,
  state: TransformState,
): string {
  if (!state.sourceIds.has(sourceId)) {
    state.sourceIds.add(sourceId);
    return sourceId;
  }

  throw new LocalSourceIdCollisionError(sourceId, range);
}

function finalizeRecords(
  records: readonly VueSourceRecord[],
  finalizer: TransformVueSfcOptions['finalizeRecords'],
): VueSourceRecord[] {
  const finalized = finalizer?.(records) ?? records;
  if (!Array.isArray(finalized) || finalized.length !== records.length) {
    throw new Error('finalizeRecords 必须保持 records 数量和顺序');
  }

  const sourceIds = new Set<string>();
  return finalized.map((record, index) => {
    const original = records[index];
    if (
      original === undefined ||
      record.moduleId !== original.moduleId ||
      record.generation !== original.generation ||
      record.rootKey !== original.rootKey ||
      record.relativePath !== original.relativePath ||
      record.framework !== original.framework ||
      record.kind !== original.kind ||
      record.tagName !== original.tagName ||
      record.range.startOffset !== original.range.startOffset ||
      record.range.endOffset !== original.range.endOffset
    ) {
      throw new Error('finalizeRecords 只能调整 sourceId 和 parentSourceId');
    }
    if (!isFullSourceId(record.sourceId) || sourceIds.has(record.sourceId)) {
      throw new Error('finalizeRecords 必须返回唯一且有效的 sourceId');
    }
    if (record.parentSourceId !== null && !isFullSourceId(record.parentSourceId)) {
      throw new Error('finalizeRecords 返回了无效 parentSourceId');
    }
    sourceIds.add(record.sourceId);
    return record;
  });
}

function getControlFlow(
  node: VueTemplateElementNode,
  nodeRange: VueSourceRange,
): VueControlFlow | null {
  return node.controlFlowKind === null
    ? null
    : {
        kind: node.controlFlowKind,
        range: nodeRange,
      };
}

function getMarkerAttribute(node: VueTemplateElementNode): string | null {
  if (node.markerKind === 'component') {
    return COMPONENT_SOURCE_ATTRIBUTE;
  }
  return node.markerKind === 'element' ? SOURCE_ATTRIBUTE : null;
}

function hasReservedAttribute(
  node: VueTemplateElementNode,
  attributeName: string,
): boolean {
  return node.reservedAttributeNames.includes(attributeName);
}

function findOpeningTagInsertionOffset(
  node: VueTemplateElementNode,
  state: TransformState,
): number {
  const absoluteStart = state.templateOffset + node.startOffset;
  const source = state.options.source;
  let quote: '"' | "'" | null = null;

  // AST 已锁定节点；这里只扫描其开始标签，避免属性字符串中的 > 被误判为标签结束。
  for (let offset = absoluteStart + 1; offset < source.length; offset += 1) {
    const character = source[offset];
    if (character === undefined) {
      break;
    }

    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '>') {
      if (source[offset - 1] !== '/') {
        return offset;
      }

      let insertionOffset = offset - 1;
      while (
        insertionOffset > absoluteStart &&
        /\s/.test(source[insertionOffset - 1] ?? '')
      ) {
        insertionOffset -= 1;
      }
      return insertionOffset;
    }
  }

  throw new Error(`无法确定 <${node.tagName}> 开始标签的结束位置`);
}

function toAbsoluteRange(
  templateStartOffset: number,
  templateEndOffset: number,
  state: TransformState,
): VueSourceRange {
  return createRange(
    state.templateOffset + templateStartOffset,
    state.templateOffset + templateEndOffset,
    state.lineIndex,
  );
}

function createRange(startOffset: number, endOffset: number, lineIndex: LineIndex): VueSourceRange {
  if (
    !Number.isSafeInteger(startOffset) ||
    !Number.isSafeInteger(endOffset) ||
    startOffset < 0 ||
    endOffset < startOffset ||
    endOffset > lineIndex.sourceLength
  ) {
    throw new RangeError('Vue AST offset 超出完整 SFC 的 UTF-16 范围');
  }
  const start = offsetToLineColumn(startOffset, lineIndex);
  const end = offsetToLineColumn(endOffset, lineIndex);
  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
    startOffset,
    endOffset,
  };
}

function createLineIndex(source: string): LineIndex {
  const starts = [0];
  for (let offset = 0; offset < source.length; offset += 1) {
    const characterCode = source.charCodeAt(offset);
    if (characterCode === 13 && source.charCodeAt(offset + 1) === 10) {
      starts.push(offset + 2);
      offset += 1;
    } else if (characterCode === 10 || characterCode === 13) {
      starts.push(offset + 1);
    }
  }
  return { starts, sourceLength: source.length };
}

function offsetToLineColumn(
  offset: number,
  lineIndex: LineIndex,
): { line: number; column: number } {
  let low = 0;
  let high = lineIndex.starts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineIndex.starts[middle];
    if (lineStart === undefined) {
      break;
    }

    if (lineStart <= offset) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const lineIndexValue = Math.max(0, high);
  const lineStart = lineIndex.starts[lineIndexValue] ?? 0;
  return {
    line: lineIndexValue + 1,
    column: offset - lineStart + 1,
  };
}

function createUnchangedResult(
  options: TransformState['options'],
  diagnostics: VueTransformDiagnostic[],
  records: VueSourceRecord[] = [],
): TransformVueSfcResult {
  const magicString = new MagicString(options.source);
  return {
    code: options.source,
    map: createSourceMap(magicString, options),
    records,
    moduleId: options.moduleId,
    diagnostics,
    transformed: false,
  };
}

function createFinalizedEmptyResult(
  options: TransformState['options'],
  diagnostics: VueTransformDiagnostic[],
): TransformVueSfcResult {
  try {
    const records = finalizeRecords([], options.finalizeRecords);
    return createUnchangedResult(options, diagnostics, records);
  } catch (error) {
    diagnostics.push({
      code: 'RECORD_FINALIZATION_ERROR',
      severity: 'error',
      message: `无法提交空 Vue source records：${toErrorMessage(error)}`,
      range: null,
    });
    return createUnchangedResult(options, diagnostics);
  }
}

function createSourceMap(
  magicString: MagicString,
  options: Pick<TransformVueSfcOptions, 'relativePath' | 'sourceMap'>,
): SourceMap | null {
  if (options.sourceMap === false) {
    return null;
  }

  return magicString.generateMap({
    source: options.relativePath,
    includeContent: true,
    hires: true,
  });
}

function createParserDiagnostic(
  code: 'SFC_PARSE_ERROR' | 'TEMPLATE_PARSE_ERROR',
  severity: 'error',
  error: VueCompilerParseError,
  lineIndex: LineIndex,
  offsetBase: number,
): VueTransformDiagnostic {
  return {
    code,
    severity,
    message: error.message,
    range:
      error.startOffset === null || error.endOffset === null
        ? null
        : createRange(
            offsetBase + error.startOffset,
            offsetBase + error.endOffset,
            lineIndex,
          ),
  };
}

function isMeaningfulRootChild(node: VueTemplateNode): boolean {
  if (node.type === 'comment') {
    return false;
  }
  if (node.type === 'text') {
    return node.content.trim().length > 0;
  }
  return true;
}

function inferComponentName(filename: string): string | null {
  const normalizedFilename = filename.replace(/\\/g, '/');
  const basename = normalizedFilename.slice(normalizedFilename.lastIndexOf('/') + 1);
  const componentName = basename.replace(/\.vue$/i, '');
  return componentName.length > 0 ? componentName : null;
}

function getContextBefore(source: string, offset: number): string | null {
  const context = source.slice(Math.max(0, offset - 80), offset);
  return context.length > 0 ? context : null;
}

function getContextAfter(source: string, offset: number): string | null {
  const context = source.slice(offset, Math.min(source.length, offset + 80));
  return context.length > 0 ? context : null;
}

function normalizeRelativePathSeparators(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function isFullSourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === FULL_SOURCE_ID_LENGTH &&
    isSourceId(value)
  );
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
