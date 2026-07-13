import { describe, expect, it } from 'vitest';

import { parseVueTemplateQuery } from './template-query.js';

describe('parseVueTemplateQuery', () => {
  it('分别接受 vue-loader 15 和 16/17 的已知 template query', () => {
    expect(
      parseVueTemplateQuery('?vue&type=template&id=abc&functional=true&scoped=true&', 15),
    ).not.toBeNull();
    expect(
      parseVueTemplateQuery('?vue&type=template&id=abc&ts=true&slotted=false', 17),
    ).not.toBeNull();
  });

  it('拒绝非 template、重复字段、未知字段和坏转义', () => {
    expect(parseVueTemplateQuery('?vue&type=style&id=abc', 17)).toBeNull();
    expect(parseVueTemplateQuery('?vue&type=template&type=template', 17)).toBeNull();
    expect(parseVueTemplateQuery('?vue&type=template&unexpected=true', 17)).toBeNull();
    expect(parseVueTemplateQuery('?vue&type=template&id=%E0%A4%A', 17)).toBeNull();
  });

  it('空 query 与缺失 vue 标记时严格旁路', () => {
    expect(parseVueTemplateQuery('', 15)).toBeNull();
    expect(parseVueTemplateQuery('?type=template&id=abc', 17)).toBeNull();
  });
});
