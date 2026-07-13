import type { VueLoaderMajor } from './types.js';

export interface VueTemplateQuery {
  vueLoaderMajor: VueLoaderMajor;
  values: ReadonlyMap<string, string>;
}

const COMMON_KEYS = new Set([
  'vue',
  'type',
  'id',
  'index',
  'lang',
  'scoped',
  'src',
  'ts',
]);
const VUE_15_KEYS = new Set([...COMMON_KEYS, 'functional', 'module']);
const VUE_16_17_KEYS = new Set([...COMMON_KEYS, 'setup', 'generic', 'slotted']);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** 只接受 vue-loader 已知的、无重复字段的 template query。 */
export function parseVueTemplateQuery(
  resourceQuery: string | undefined,
  vueLoaderMajor: VueLoaderMajor,
): VueTemplateQuery | null {
  if (!resourceQuery || resourceQuery[0] !== '?' || resourceQuery.length === 1) {
    return null;
  }

  const allowedKeys = vueLoaderMajor === 15 ? VUE_15_KEYS : VUE_16_17_KEYS;
  const values = new Map<string, string>();
  const segments = resourceQuery.slice(1).split('&');
  for (const segment of segments) {
    if (segment.length === 0) {
      continue;
    }
    const separator = segment.indexOf('=');
    const rawKey = separator < 0 ? segment : segment.slice(0, separator);
    const rawValue = separator < 0 ? '' : segment.slice(separator + 1);
    const key = decodeQueryPart(rawKey);
    const value = decodeQueryPart(rawValue);
    if (
      key === null ||
      value === null ||
      !allowedKeys.has(key) ||
      values.has(key) ||
      CONTROL_CHARACTER_PATTERN.test(value)
    ) {
      return null;
    }
    values.set(key, value);
  }

  const vueFlag = values.get('vue');
  if (vueFlag !== '' && vueFlag !== 'true') {
    return null;
  }
  if (!values.has('vue') || values.get('type') !== 'template') {
    return null;
  }
  if (!hasValidOptionalBoolean(values, 'scoped') || !hasValidOptionalBoolean(values, 'src')) {
    return null;
  }
  if (!hasValidOptionalBoolean(values, 'ts') || !hasValidOptionalBoolean(values, 'slotted')) {
    return null;
  }
  if (vueLoaderMajor === 15 && !hasValidOptionalBoolean(values, 'functional')) {
    return null;
  }
  const index = values.get('index');
  if (index !== undefined && !/^(0|[1-9]\d*)$/.test(index)) {
    return null;
  }
  const id = values.get('id');
  if (id !== undefined && (id.length === 0 || id.length > 256)) {
    return null;
  }
  const lang = values.get('lang');
  if (lang !== undefined && (lang.length === 0 || lang.length > 64)) {
    return null;
  }

  return { vueLoaderMajor, values };
}

/** Pug 等预处理 template 与 external src 首版保持纯旁路。 */
export function isInspectableHtmlTemplateQuery(query: VueTemplateQuery): boolean {
  const templateLanguage = query.values.get('lang');
  const externalSource = query.values.get('src');
  return (
    (templateLanguage === undefined || templateLanguage.toLowerCase() === 'html') &&
    externalSource !== '' &&
    externalSource !== 'true'
  );
}

function decodeQueryPart(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function hasValidOptionalBoolean(values: ReadonlyMap<string, string>, key: string): boolean {
  const value = values.get(key);
  return value === undefined || value === '' || value === 'true' || value === 'false';
}
