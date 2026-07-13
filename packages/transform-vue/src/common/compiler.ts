export type VueCompilerFamily = 'vue2.6' | 'vue2.7' | 'vue3';

export type VueNormalizedSourceKind =
  | 'element'
  | 'component'
  | 'fragment'
  | 'slot'
  | 'dynamic';

export type VueNormalizedControlFlowKind = 'for' | 'if' | 'else-if' | 'else';

export type VueMarkerKind = 'element' | 'component' | null;

export interface VueCompilerParseError {
  message: string;
  /** 相对当前 parser 输入的 UTF-16 offset。 */
  startOffset: number | null;
  /** 相对当前 parser 输入的 UTF-16 exclusive end offset。 */
  endOffset: number | null;
}

export interface VueSfcTemplateBlock {
  content: string;
  /** template 内容在完整 SFC 中的起始 UTF-16 offset。 */
  startOffset: number;
  endOffset: number;
  lang?: string;
  src?: string;
}

export interface VueSfcParseResult {
  template: VueSfcTemplateBlock | null;
  errors: VueCompilerParseError[];
}

export interface VueTemplateTextNode {
  type: 'text' | 'comment';
  content: string;
  startOffset: number;
  endOffset: number;
}

export interface VueTemplateElementNode {
  type: 'element';
  tagName: string;
  sourceKind: VueNormalizedSourceKind;
  markerKind: VueMarkerKind;
  controlFlowKind: VueNormalizedControlFlowKind | null;
  /** 包含普通属性以及静态参数 v-bind 的小写属性名。 */
  reservedAttributeNames: readonly string[];
  startOffset: number;
  endOffset: number;
  children: VueTemplateNode[];
}

export type VueTemplateNode = VueTemplateElementNode | VueTemplateTextNode;

export interface VueTemplateParseResult {
  children: VueTemplateNode[];
  errors: VueCompilerParseError[];
}

/**
 * 不同 Vue compiler 的最小适配合同。offset 均相对 parser 当前输入，
 * 由通用转换层统一换算为完整 SFC 坐标。
 */
export interface VueCompilerAdapter {
  readonly family: VueCompilerFamily;
  readonly version: string;
  parseSfc(source: string, filename: string): VueSfcParseResult;
  parseTemplate(source: string, filename: string): VueTemplateParseResult;
}

export function normalizeCompilerError(error: unknown): VueCompilerParseError {
  const candidate = asRecord(error);
  const location = asRecord(candidate?.loc);
  const locationStart = asRecord(location?.start);
  const locationEnd = asRecord(location?.end);
  const directStart = toFiniteOffset(candidate?.start);
  const directEnd = toFiniteOffset(candidate?.end);
  const locationStartOffset = toFiniteOffset(locationStart?.offset);
  const locationEndOffset = toFiniteOffset(locationEnd?.offset);
  const startOffset = locationStartOffset ?? directStart;
  const endOffset = locationEndOffset ?? directEnd ?? startOffset;

  return {
    message: toErrorMessage(error),
    startOffset,
    endOffset,
  };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function toFiniteOffset(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const candidate = asRecord(error);
  if (typeof candidate?.message === 'string') {
    return candidate.message;
  }
  if (typeof candidate?.msg === 'string') {
    return candidate.msg;
  }
  return String(error);
}
