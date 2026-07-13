import { digestCanonical } from '../digest';
import recast from 'recast';

const AST_METADATA_KEYS = new Set([
  'end',
  'errors',
  'extra',
  'loc',
  'original',
  'raw',
  'rawValue',
  'start',
  'tokens',
]);
const START_ANCHOR = 'START';
const END_ANCHOR = 'END';
const OPTIONAL_FALSE_KEYS = new Set(['definite', 'optional']);

function canonicalAstValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalAstValue(item, seen));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (seen.has(value)) {
    throw new Error('AST 包含无法安全指纹化的循环引用');
  }
  seen.add(value);
  const candidate = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.entries(candidate)
      .filter(([key, item]) => !AST_METADATA_KEYS.has(key)
        && item !== undefined
        && item !== null
        && !(item === false && OPTIONAL_FALSE_KEYS.has(key))
        && !(key === 'kind' && item === 'init'
          && (candidate.type === 'Property' || candidate.type === 'ObjectProperty'))
        && !((key === 'importKind' || key === 'exportKind') && item === 'value'))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [
        key,
        key === 'type' && item === 'Property'
          ? 'ObjectProperty'
          : canonicalAstValue(item, seen),
      ]),
  );
  seen.delete(value);
  return normalized;
}

function structuralFingerprint(node: unknown): string {
  return digestCanonical(['ast-structure-v1', printableAstValue(node)]);
}

function printableAstValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(printableAstValue);
  }
  if (typeof value === 'object' && value !== null
    && typeof (value as { type?: unknown }).type === 'string') {
    // prettyPrint 消除 parser/builder 元数据差异，同时保留节点结构与注释变化。
    const type = (value as { type: string }).type === 'Property'
      ? 'ObjectProperty'
      : (value as { type: string }).type;
    return {
      type,
      code: recast.prettyPrint(value as never, { tabWidth: 2 }).code,
    };
  }
  return canonicalAstValue(value, new WeakSet());
}

export function astOperationFingerprint(scope: readonly unknown[], node: unknown): string {
  return digestCanonical([
    'owned-ast-operation-v1',
    ...scope,
    printableAstValue(node),
  ]);
}

export function sameAstStructure(left: unknown, right: unknown): boolean {
  return structuralFingerprint(left) === structuralFingerprint(right);
}

export function capturePositionAnchors(
  elements: readonly unknown[],
  index: number,
): Record<'previousAnchor' | 'nextAnchor', string> {
  return {
    previousAnchor: index === 0
      ? START_ANCHOR
      : structuralFingerprint(elements[index - 1]),
    nextAnchor: index === elements.length - 1
      ? END_ANCHOR
      : structuralFingerprint(elements[index + 1]),
  };
}

function uniqueAnchorIndex(elements: readonly unknown[], anchor: string): number | undefined {
  const matches = elements.flatMap((element, index) =>
    structuralFingerprint(element) === anchor ? [index] : []);
  return matches.length === 1 ? matches[0] : undefined;
}

export function restoreByPositionAnchors(
  elements: readonly unknown[],
  currentIndex: number,
  details: Readonly<Record<string, string>> | undefined,
): unknown[] | undefined {
  const prePrevious = details?.prePrevious;
  const preNext = details?.preNext;
  const postPrevious = details?.postPrevious;
  const postNext = details?.postNext;
  if (!prePrevious || !preNext || !postPrevious || !postNext) {
    return undefined;
  }
  const currentPrevious = currentIndex === 0
    ? START_ANCHOR
    : structuralFingerprint(elements[currentIndex - 1]);
  const currentNext = currentIndex === elements.length - 1
    ? END_ANCHOR
    : structuralFingerprint(elements[currentIndex + 1]);
  if (currentPrevious !== postPrevious || currentNext !== postNext) {
    return undefined;
  }
  const restored = [...elements];
  const [node] = restored.splice(currentIndex, 1);
  const previousIndex = prePrevious === START_ANCHOR
    ? -1
    : uniqueAnchorIndex(restored, prePrevious);
  const nextIndex = preNext === END_ANCHOR
    ? restored.length
    : uniqueAnchorIndex(restored, preNext);
  if (previousIndex === undefined || nextIndex === undefined || nextIndex !== previousIndex + 1) {
    return undefined;
  }
  restored.splice(nextIndex, 0, node);
  return restored;
}
