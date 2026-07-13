import {
  asRecord,
  normalizeCompilerError,
  toFiniteOffset,
  type VueCompilerAdapter,
  type VueCompilerParseError,
  type VueMarkerKind,
  type VueNormalizedControlFlowKind,
  type VueNormalizedSourceKind,
  type VueSfcParseResult,
  type VueSfcTemplateBlock,
  type VueTemplateElementNode,
  type VueTemplateNode,
  type VueTemplateParseResult,
} from '../common/compiler.js';

export interface CreateVue3CompilerAdapterOptions {
  /** 消费项目实际使用的 @vue/compiler-sfc 模块。 */
  compilerSfc: unknown;
  /** 消费项目实际使用的 @vue/compiler-dom 模块。 */
  compilerDom: unknown;
  version?: string;
}

interface Vue3CompilerConstants {
  elementNode: number;
  textNode: number;
  commentNode: number;
  attributeNode: number;
  directiveNode: number;
  simpleExpressionNode: number;
  nativeElement: number;
  componentElement: number;
  slotElement: number;
  templateElement: number;
}

const DEFAULT_CONSTANTS: Vue3CompilerConstants = {
  elementNode: 1,
  textNode: 2,
  commentNode: 3,
  attributeNode: 6,
  directiveNode: 7,
  simpleExpressionNode: 4,
  nativeElement: 0,
  componentElement: 1,
  slotElement: 2,
  templateElement: 3,
};

const NON_DOM_COMPONENTS = new Set([
  'keepalive',
  'suspense',
  'teleport',
  'transition',
  'transitiongroup',
]);

/** 使用调用方注入的 Vue 3 compiler，避免绑定本包构建时的 compiler 版本。 */
export function createVue3CompilerAdapter(
  options: CreateVue3CompilerAdapterOptions,
): VueCompilerAdapter {
  const compilerSfc = requireModuleRecord(options.compilerSfc, '@vue/compiler-sfc');
  const compilerDom = requireModuleRecord(options.compilerDom, '@vue/compiler-dom');
  const parseSfc = requireFunction(compilerSfc, 'parse', '@vue/compiler-sfc');
  const parseTemplate = requireFunction(compilerDom, 'parse', '@vue/compiler-dom');
  const constants = readCompilerConstants(compilerDom);
  const version = options.version ?? readVersion(compilerSfc);

  return {
    family: 'vue3',
    version,
    parseSfc(source, filename) {
      return parseVue3Sfc(parseSfc, source, filename);
    },
    parseTemplate(source, filename) {
      const errors: VueCompilerParseError[] = [];
      const root = asRecord(
        parseTemplate(source, {
          comments: true,
          filename,
          onError(error: unknown) {
            errors.push(normalizeCompilerError(error));
          },
        }),
      );
      const children = readArray(root?.children).map((node) =>
        normalizeVue3Node(node, constants),
      );
      return { children, errors };
    },
  };
}

function parseVue3Sfc(
  parseSfc: Callable,
  source: string,
  filename: string,
): VueSfcParseResult {
  const result = asRecord(
    parseSfc(source, {
      filename,
      sourceMap: false,
    }),
  );
  const errors = readArray(result?.errors).map(normalizeCompilerError);
  const descriptor = asRecord(result?.descriptor);
  const rawTemplate = descriptor?.template;
  if (rawTemplate === null || rawTemplate === undefined) {
    return { template: null, errors };
  }

  return {
    template: normalizeVue3TemplateBlock(rawTemplate),
    errors,
  };
}

function normalizeVue3TemplateBlock(value: unknown): VueSfcTemplateBlock {
  const block = requireRecord(value, 'Vue SFC template block');
  const content = requireString(block.content, 'Vue SFC template content');
  const location = asRecord(block.loc);
  const locationStart = asRecord(location?.start);
  const locationEnd = asRecord(location?.end);
  const startOffset = toFiniteOffset(locationStart?.offset) ?? toFiniteOffset(block.start);
  const endOffset = toFiniteOffset(locationEnd?.offset) ?? toFiniteOffset(block.end);
  if (startOffset === null) {
    throw new TypeError('Vue 3 compiler 未返回 template 内容的 start offset');
  }

  return {
    content,
    startOffset,
    endOffset: endOffset ?? startOffset + content.length,
    lang: optionalString(block.lang),
    src: optionalString(block.src),
  };
}

function normalizeVue3Node(
  value: unknown,
  constants: Vue3CompilerConstants,
): VueTemplateNode {
  const node = requireRecord(value, 'Vue 3 template node');
  const nodeType = requireNumber(node.type, 'Vue 3 template node type');
  const location = requireRecord(node.loc, 'Vue 3 template node location');
  const start = requireRecord(location.start, 'Vue 3 template node start');
  const end = requireRecord(location.end, 'Vue 3 template node end');
  const startOffset = requireOffset(start.offset, 'Vue 3 template node start offset');
  const endOffset = requireOffset(end.offset, 'Vue 3 template node end offset');

  if (nodeType === constants.elementNode) {
    return normalizeVue3Element(node, startOffset, endOffset, constants);
  }

  const content =
    typeof node.content === 'string'
      ? node.content
      : typeof location.source === 'string'
        ? location.source
        : '';
  return {
    type: nodeType === constants.commentNode ? 'comment' : 'text',
    content,
    startOffset,
    endOffset,
  };
}

function normalizeVue3Element(
  node: Record<string, unknown>,
  startOffset: number,
  endOffset: number,
  constants: Vue3CompilerConstants,
): VueTemplateElementNode {
  const tagName = requireString(node.tag, 'Vue 3 element tag');
  const tagType = requireNumber(node.tagType, 'Vue 3 element tag type');
  const properties = readArray(node.props).map((property) =>
    requireRecord(property, 'Vue 3 element property'),
  );
  const sourceKind = getVue3SourceKind(tagName, tagType, constants);

  return {
    type: 'element',
    tagName,
    sourceKind,
    markerKind: getVue3MarkerKind(tagName, tagType, constants),
    controlFlowKind: getVue3ControlFlowKind(properties, constants),
    reservedAttributeNames: getVue3AttributeNames(properties, constants),
    startOffset,
    endOffset,
    children: readArray(node.children).map((child) =>
      normalizeVue3Node(child, constants),
    ),
  };
}

function getVue3SourceKind(
  tagName: string,
  tagType: number,
  constants: Vue3CompilerConstants,
): VueNormalizedSourceKind {
  if (tagType === constants.templateElement) {
    return 'fragment';
  }
  if (tagType === constants.slotElement) {
    return 'slot';
  }
  if (tagName.toLowerCase() === 'component') {
    return 'dynamic';
  }
  return tagType === constants.nativeElement ? 'element' : 'component';
}

function getVue3MarkerKind(
  tagName: string,
  tagType: number,
  constants: Vue3CompilerConstants,
): VueMarkerKind {
  if (tagType === constants.templateElement || tagType === constants.slotElement) {
    return null;
  }
  if (tagType === constants.componentElement) {
    return NON_DOM_COMPONENTS.has(normalizeTagName(tagName)) ? null : 'component';
  }
  return 'element';
}

function getVue3ControlFlowKind(
  properties: readonly Record<string, unknown>[],
  constants: Vue3CompilerConstants,
): VueNormalizedControlFlowKind | null {
  for (const property of properties) {
    if (property.type !== constants.directiveNode || typeof property.name !== 'string') {
      continue;
    }
    if (isControlFlowKind(property.name)) {
      return property.name;
    }
  }
  return null;
}

function getVue3AttributeNames(
  properties: readonly Record<string, unknown>[],
  constants: Vue3CompilerConstants,
): string[] {
  const names = new Set<string>();
  for (const property of properties) {
    if (property.type === constants.attributeNode && typeof property.name === 'string') {
      names.add(property.name.toLowerCase());
      continue;
    }
    if (property.type !== constants.directiveNode || property.name !== 'bind') {
      continue;
    }
    const argument = asRecord(property.arg);
    if (
      argument?.type === constants.simpleExpressionNode &&
      argument.isStatic === true &&
      typeof argument.content === 'string'
    ) {
      names.add(argument.content.toLowerCase());
    }
  }
  return [...names];
}

function readCompilerConstants(compilerDom: Record<string, unknown>): Vue3CompilerConstants {
  const nodeTypes = asRecord(compilerDom.NodeTypes);
  const elementTypes = asRecord(compilerDom.ElementTypes);
  return {
    elementNode: readNumber(nodeTypes?.ELEMENT, DEFAULT_CONSTANTS.elementNode),
    textNode: readNumber(nodeTypes?.TEXT, DEFAULT_CONSTANTS.textNode),
    commentNode: readNumber(nodeTypes?.COMMENT, DEFAULT_CONSTANTS.commentNode),
    attributeNode: readNumber(nodeTypes?.ATTRIBUTE, DEFAULT_CONSTANTS.attributeNode),
    directiveNode: readNumber(nodeTypes?.DIRECTIVE, DEFAULT_CONSTANTS.directiveNode),
    simpleExpressionNode: readNumber(
      nodeTypes?.SIMPLE_EXPRESSION,
      DEFAULT_CONSTANTS.simpleExpressionNode,
    ),
    nativeElement: readNumber(elementTypes?.ELEMENT, DEFAULT_CONSTANTS.nativeElement),
    componentElement: readNumber(
      elementTypes?.COMPONENT,
      DEFAULT_CONSTANTS.componentElement,
    ),
    slotElement: readNumber(elementTypes?.SLOT, DEFAULT_CONSTANTS.slotElement),
    templateElement: readNumber(
      elementTypes?.TEMPLATE,
      DEFAULT_CONSTANTS.templateElement,
    ),
  };
}

type Callable = (input: string, options: Record<string, unknown>) => unknown;

function requireFunction(
  module: Record<string, unknown>,
  name: string,
  moduleName: string,
): Callable {
  const value = module[name];
  if (typeof value !== 'function') {
    throw new TypeError(`${moduleName} 未导出 ${name} 函数`);
  }
  return value as Callable;
}

function requireModuleRecord(value: unknown, name: string): Record<string, unknown> {
  const module = asRecord(value);
  const defaultExport = asRecord(module?.default);
  const normalized = module && typeof module.parse === 'function' ? module : defaultExport;
  if (normalized === null) {
    throw new TypeError(`${name} 不是有效 compiler 模块`);
  }
  return normalized;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record === null) {
    throw new TypeError(`${label} 缺失`);
  }
  return record;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} 缺失`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`${label} 缺失`);
  }
  return value;
}

function requireOffset(value: unknown, label: string): number {
  const offset = toFiniteOffset(value);
  if (offset === null) {
    throw new TypeError(`${label} 缺失`);
  }
  return offset;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function readVersion(module: Record<string, unknown>): string {
  return typeof module.version === 'string' ? module.version : 'unknown';
}

function isControlFlowKind(value: string): value is VueNormalizedControlFlowKind {
  return value === 'for' || value === 'if' || value === 'else-if' || value === 'else';
}

function normalizeTagName(tagName: string): string {
  return tagName.toLowerCase().replace(/-/g, '');
}
