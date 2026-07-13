import {
  asRecord,
  normalizeCompilerError,
  toFiniteOffset,
  type VueCompilerAdapter,
  type VueCompilerParseError,
  type VueCompilerFamily,
  type VueMarkerKind,
  type VueNormalizedControlFlowKind,
  type VueNormalizedSourceKind,
  type VueSfcParseResult,
  type VueSfcTemplateBlock,
  type VueTemplateElementNode,
  type VueTemplateNode,
  type VueTemplateParseResult,
} from '../common/compiler.js';

export interface CreateVue26CompilerAdapterOptions {
  /** 消费项目中与 vue 同版本的 vue-template-compiler。 */
  compiler: unknown;
  version?: string;
}

export interface CreateVue27CompilerAdapterOptions {
  /** 消费项目的 vue/compiler-sfc。 */
  compilerSfc: unknown;
  /** vue-loader 实际使用的模板 compiler；未提供时使用 compileTemplate。 */
  templateCompiler?: unknown;
  version?: string;
}

const NON_DOM_COMPONENTS = new Set([
  'keepalive',
  'transition',
  'transitiongroup',
]);

const HTML_TAGS = new Set(
  (
    'html,body,base,head,link,meta,style,title,address,article,aside,footer,header,' +
    'h1,h2,h3,h4,h5,h6,nav,section,div,dd,dl,dt,figcaption,figure,picture,hr,img,' +
    'li,main,ol,p,pre,ul,a,b,abbr,bdi,bdo,br,cite,code,data,dfn,em,i,kbd,mark,q,' +
    'rp,rt,ruby,s,samp,small,span,strong,sub,sup,time,u,var,wbr,area,audio,map,' +
    'track,video,embed,object,param,source,canvas,script,noscript,del,ins,caption,' +
    'col,colgroup,table,thead,tbody,td,th,tr,button,datalist,fieldset,form,input,' +
    'label,legend,meter,optgroup,option,output,progress,select,textarea,details,' +
    'dialog,menu,summary,template,blockquote,iframe,tfoot'
  ).split(','),
);

const HTML_VOID_TAGS = new Set(
  'area,base,br,col,embed,frame,hr,img,input,isindex,keygen,link,meta,param,source,track,wbr'.split(','),
);

const SVG_TAGS = new Set(
  (
    'svg,animate,circle,clippath,cursor,defs,desc,ellipse,filter,font-face,' +
    'foreignobject,g,glyph,image,line,marker,mask,missing-glyph,path,pattern,' +
    'polygon,polyline,rect,switch,symbol,text,textpath,tspan,use,view'
  ).split(','),
);

/** Vue 2.6 使用项目自身 vue-template-compiler 的 source range AST。 */
export function createVue26CompilerAdapter(
  options: CreateVue26CompilerAdapterOptions,
): VueCompilerAdapter {
  const compiler = requireModuleRecord(options.compiler, 'vue-template-compiler');
  const parseComponent = requireFunction(compiler, 'parseComponent', 'vue-template-compiler');
  const compile = requireFunction(compiler, 'compile', 'vue-template-compiler');

  return createVue2CompilerAdapter({
    family: 'vue2.6',
    version: options.version ?? readVersion(compiler),
    parseSfc(source, filename) {
      const descriptor = asRecord(
        parseComponent(source, {
          filename,
          deindent: false,
          outputSourceRange: true,
        }),
      );
      return normalizeVue26Sfc(descriptor);
    },
    compileTemplate(source) {
      return compile(source, {
        outputSourceRange: true,
      });
    },
  });
}

/** Vue 2.7 优先复用 vue-loader 注入的 compiler，否则使用 vue/compiler-sfc。 */
export function createVue27CompilerAdapter(
  options: CreateVue27CompilerAdapterOptions,
): VueCompilerAdapter {
  const compilerSfc = requireModuleRecord(options.compilerSfc, 'vue/compiler-sfc');
  const parseComponent = requireFunction(compilerSfc, 'parseComponent', 'vue/compiler-sfc');
  const templateCompiler = options.templateCompiler === undefined
    ? null
    : requireModuleRecord(options.templateCompiler, 'Vue 2.7 template compiler');
  const compile = templateCompiler === null
    ? null
    : requireFunction(templateCompiler, 'compile', 'Vue 2.7 template compiler');
  const compileTemplate = compile === null
    ? requireFunction(compilerSfc, 'compileTemplate', 'vue/compiler-sfc')
    : null;

  return createVue2CompilerAdapter({
    family: 'vue2.7',
    version: options.version ?? readVersion(compilerSfc),
    parseSfc(source, filename) {
      const result = asRecord(
        parseComponent(source, {
          filename,
          deindent: false,
          sourceMap: false,
        }),
      );
      return normalizeVue27Sfc(result);
    },
    compileTemplate(source, filename) {
      if (compile !== null) {
        return compile(source, {
          outputSourceRange: true,
        });
      }
      return compileTemplate?.({
        source,
        filename,
        id: 'wsi',
        compilerOptions: {
          outputSourceRange: true,
        },
      });
    },
  });
}

interface Vue2AdapterInput {
  family: VueCompilerFamily;
  version: string;
  parseSfc(source: string, filename: string): VueSfcParseResult;
  compileTemplate(source: string, filename: string): unknown;
}

function createVue2CompilerAdapter(input: Vue2AdapterInput): VueCompilerAdapter {
  return {
    family: input.family,
    version: input.version,
    parseSfc: input.parseSfc,
    parseTemplate(source, filename) {
      const compilerInput = createVue2TemplateCompilerInput(source);
      const result = asRecord(input.compileTemplate(compilerInput.source, filename));
      const errors = readArray(result?.errors)
        .map(normalizeCompilerError)
        .map((error) => mapVue2CompilerErrorOffsets(error, compilerInput.mapOffset));
      const ast = asRecord(result?.ast);
      if (ast === null) {
        if (compilerInput.source.length === 0 && errors.length === 0) {
          return { children: [], errors: [] };
        }
        if (errors.length === 0) {
          errors.push({
            message: 'Vue 2 template compiler 未返回 AST',
            startOffset: null,
            endOffset: null,
          });
        }
        return { children: [], errors };
      }

      return {
        children: normalizeVue2SiblingElements([ast], compilerInput.mapOffset),
        errors,
      };
    },
  };
}

type Vue2TemplateOffsetMapper = (offset: number) => number;

function createVue2TemplateCompilerInput(source: string): {
  source: string;
  mapOffset: Vue2TemplateOffsetMapper;
} {
  const compilerSource = source.trim();
  const leadingWhitespaceLength = source.length - source.trimStart().length;
  return {
    source: compilerSource,
    // Vue 2 compiler 内部会 trim template，但 AST 范围不会补回前导空白。
    mapOffset: (offset) => leadingWhitespaceLength + offset,
  };
}

function mapVue2CompilerErrorOffsets(
  error: VueCompilerParseError,
  mapOffset: Vue2TemplateOffsetMapper,
): VueCompilerParseError {
  return {
    ...error,
    startOffset: error.startOffset === null ? null : mapOffset(error.startOffset),
    endOffset: error.endOffset === null ? null : mapOffset(error.endOffset),
  };
}

function normalizeVue26Sfc(descriptor: Record<string, unknown> | null): VueSfcParseResult {
  const rawTemplate = descriptor?.template;
  return {
    template:
      rawTemplate === null || rawTemplate === undefined
        ? null
        : normalizeVue2TemplateBlock(rawTemplate),
    errors: [],
  };
}

function normalizeVue27Sfc(result: Record<string, unknown> | null): VueSfcParseResult {
  const descriptor = asRecord(result?.descriptor) ?? result;
  const rawTemplate = descriptor?.template;
  return {
    template:
      rawTemplate === null || rawTemplate === undefined
        ? null
        : normalizeVue2TemplateBlock(rawTemplate),
    errors: readArray(result?.errors)
      .map(normalizeCompilerError)
      .filter((error) => !isVue27VoidTagSfcParserError(error)),
  };
}

function isVue27VoidTagSfcParserError(error: VueCompilerParseError): boolean {
  const match = /^tag <([A-Za-z][A-Za-z0-9-]*)> has no matching end tag\.$/u.exec(error.message);
  // Vue 2.7 的 SFC 分块解析器会误报 HTML void 标签，template compiler 会再次做权威校验。
  return match !== null && HTML_VOID_TAGS.has((match[1] ?? '').toLowerCase());
}

function normalizeVue2TemplateBlock(value: unknown): VueSfcTemplateBlock {
  const block = requireRecord(value, 'Vue 2 SFC template block');
  const content = requireString(block.content, 'Vue 2 SFC template content');
  const location = asRecord(block.loc);
  const locationStart = asRecord(location?.start);
  const locationEnd = asRecord(location?.end);
  const startOffset = toFiniteOffset(block.start) ?? toFiniteOffset(locationStart?.offset);
  const endOffset = toFiniteOffset(block.end) ?? toFiniteOffset(locationEnd?.offset);
  if (startOffset === null) {
    throw new TypeError('Vue 2 compiler 未返回 template 内容的 start offset');
  }

  return {
    content,
    startOffset,
    endOffset: endOffset ?? startOffset + content.length,
    lang: optionalString(block.lang),
    src: optionalString(block.src),
  };
}

function normalizeVue2SiblingElements(
  values: readonly unknown[],
  mapOffset: Vue2TemplateOffsetMapper,
): VueTemplateNode[] {
  const normalized: VueTemplateNode[] = [];
  const seen = new Set<unknown>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    const node = normalizeVue2Node(value, mapOffset);
    if (node === null) {
      continue;
    }
    normalized.push(node);

    // Vue 2 将 v-else(-if) 收进前一节点的 ifConditions，需要恢复为同级候选。
    if (node.type === 'element') {
      const rawNode = asRecord(value);
      const conditions = readArray(rawNode?.ifConditions).slice(1);
      for (const condition of conditions) {
        const block = asRecord(condition)?.block;
        if (block !== undefined && !seen.has(block)) {
          seen.add(block);
          const conditionNode = normalizeVue2Node(block, mapOffset);
          if (conditionNode !== null) {
            normalized.push(conditionNode);
          }
        }
      }
    }
  }
  return normalized;
}

function normalizeVue2Node(
  value: unknown,
  mapOffset: Vue2TemplateOffsetMapper,
): VueTemplateNode | null {
  const node = requireRecord(value, 'Vue 2 template node');
  const nodeType = requireNumber(node.type, 'Vue 2 template node type');
  if (nodeType !== 1 && (toFiniteOffset(node.start) === null || toFiniteOffset(node.end) === null)) {
    // Vue 2.7 的插值文本节点可能没有范围，且这类节点不参与 marker 注入。
    return null;
  }
  const startOffset = mapOffset(requireOffset(node.start, 'Vue 2 template node start offset'));
  const endOffset = mapOffset(requireOffset(node.end, 'Vue 2 template node end offset'));

  if (nodeType !== 1) {
    return {
      type: node.isComment === true ? 'comment' : 'text',
      content: typeof node.text === 'string' ? node.text : '',
      startOffset,
      endOffset,
    };
  }

  return normalizeVue2Element(node, startOffset, endOffset, mapOffset);
}

function normalizeVue2Element(
  node: Record<string, unknown>,
  startOffset: number,
  endOffset: number,
  mapOffset: Vue2TemplateOffsetMapper,
): VueTemplateElementNode {
  const tagName = requireString(node.tag, 'Vue 2 element tag');
  const sourceKind = getVue2SourceKind(tagName, node);
  return {
    type: 'element',
    tagName,
    sourceKind,
    markerKind: getVue2MarkerKind(tagName, sourceKind),
    controlFlowKind: getVue2ControlFlowKind(node),
    reservedAttributeNames: getVue2AttributeNames(node),
    startOffset,
    endOffset,
    children: normalizeVue2SiblingElements(readArray(node.children), mapOffset),
  };
}

function getVue2SourceKind(
  tagName: string,
  node: Record<string, unknown>,
): VueNormalizedSourceKind {
  const normalizedTag = tagName.toLowerCase();
  if (normalizedTag === 'template') {
    return 'fragment';
  }
  if (normalizedTag === 'slot') {
    return 'slot';
  }
  if (normalizedTag === 'component' || node.component !== undefined) {
    return 'dynamic';
  }
  return isNativeTag(normalizedTag) ? 'element' : 'component';
}

function getVue2MarkerKind(
  tagName: string,
  sourceKind: VueNormalizedSourceKind,
): VueMarkerKind {
  if (sourceKind === 'fragment' || sourceKind === 'slot') {
    return null;
  }
  if (sourceKind === 'component') {
    return NON_DOM_COMPONENTS.has(normalizeTagName(tagName)) ? null : 'component';
  }
  if (sourceKind === 'dynamic') {
    return 'component';
  }
  return 'element';
}

function getVue2ControlFlowKind(
  node: Record<string, unknown>,
): VueNormalizedControlFlowKind | null {
  const attributes = asRecord(node.attrsMap);
  if (node.for !== undefined || attributes?.['v-for'] !== undefined) {
    return 'for';
  }
  if (node.if !== undefined || attributes?.['v-if'] !== undefined) {
    return 'if';
  }
  if (node.elseif !== undefined || attributes?.['v-else-if'] !== undefined) {
    return 'else-if';
  }
  if (node.else === true || attributes?.['v-else'] !== undefined) {
    return 'else';
  }
  return null;
}

function getVue2AttributeNames(node: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const rawAttribute of readArray(node.attrsList)) {
    const attribute = asRecord(rawAttribute);
    if (typeof attribute?.name === 'string') {
      const name = normalizeVue2BoundAttributeName(attribute.name);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  const attributes = asRecord(node.attrsMap);
  for (const name of Object.keys(attributes ?? {})) {
    const normalized = normalizeVue2BoundAttributeName(name);
    if (normalized !== null) {
      names.add(normalized);
    }
  }
  return [...names];
}

function normalizeVue2BoundAttributeName(name: string): string | null {
  const normalized = name.toLowerCase();
  if (normalized.startsWith(':')) {
    return normalized.slice(1).split('.')[0] ?? null;
  }
  if (normalized.startsWith('v-bind:')) {
    return normalized.slice('v-bind:'.length).split('.')[0] ?? null;
  }
  return normalized.startsWith('v-') || normalized.startsWith('@')
    ? null
    : normalized;
}

function isNativeTag(tagName: string): boolean {
  return HTML_TAGS.has(tagName) || SVG_TAGS.has(tagName);
}

type Callable = (...arguments_: unknown[]) => unknown;

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
  const hasCompilerFunction =
    typeof module?.parseComponent === 'function' ||
    typeof module?.parse === 'function' ||
    typeof module?.compile === 'function' ||
    typeof module?.compileTemplate === 'function';
  const normalized = hasCompilerFunction ? module : defaultExport;
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
    throw new TypeError(`${label} 缺失；请确认 compiler 启用了 outputSourceRange`);
  }
  return offset;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readVersion(module: Record<string, unknown>): string {
  return typeof module.version === 'string' ? module.version : 'unknown';
}

function normalizeTagName(tagName: string): string {
  return tagName.toLowerCase().replace(/-/g, '');
}
