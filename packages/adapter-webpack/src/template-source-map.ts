import MagicString, { type SourceMap } from 'magic-string';

/**
 * Transform 只向 template 增加 marker。这里裁出 template 生成段，
 * 同时让原始坐标仍指向完整 SFC。
 */
export function createTemplateSourceMap(
  fullSource: string,
  templateStartOffset: number,
  templateEndOffset: number,
  originalTemplate: string,
  transformedTemplate: string,
  relativePath: string,
): SourceMap {
  const insertions = findInsertions(originalTemplate, transformedTemplate);
  const magicString = new MagicString(fullSource);
  for (const insertion of insertions) {
    magicString.appendLeft(templateStartOffset + insertion.offset, insertion.content);
  }
  magicString.remove(templateEndOffset, fullSource.length);
  magicString.remove(0, templateStartOffset);
  return magicString.generateMap({
    source: relativePath,
    includeContent: true,
    hires: true,
  });
}

interface TextInsertion {
  offset: number;
  content: string;
}

function findInsertions(original: string, transformed: string): TextInsertion[] {
  const insertions: TextInsertion[] = [];
  let originalOffset = 0;
  let transformedOffset = 0;
  while (originalOffset < original.length) {
    if (original[originalOffset] === transformed[transformedOffset]) {
      originalOffset += 1;
      transformedOffset += 1;
      continue;
    }
    const nextOriginalCharacter = original[originalOffset];
    const nextMatch = transformed.indexOf(nextOriginalCharacter ?? '', transformedOffset);
    if (nextOriginalCharacter === undefined || nextMatch < transformedOffset) {
      throw new Error('TEMPLATE_PIPELINE_MISMATCH:Vue Transform 结果不是仅插入 marker');
    }
    const content = transformed.slice(transformedOffset, nextMatch);
    if (content.length === 0) {
      throw new Error('TEMPLATE_PIPELINE_MISMATCH:无法回映 Vue template Transform');
    }
    insertions.push({ offset: originalOffset, content });
    transformedOffset = nextMatch;
  }
  if (transformedOffset < transformed.length) {
    insertions.push({
      offset: original.length,
      content: transformed.slice(transformedOffset),
    });
  }
  return insertions;
}
