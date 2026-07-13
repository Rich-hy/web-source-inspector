import { describe, expect, it } from 'vitest';
import { createSourceDigest } from '@web-source-inspector/compiler-core';

import {
  COMPONENT_SOURCE_ATTRIBUTE,
  SOURCE_ATTRIBUTE,
  createVue26CompilerAdapter,
  createVue27CompilerAdapter,
  transformVueSfc,
  type VueSourceIdInput,
} from './index.js';

function createSourceId(input: VueSourceIdInput): string {
  return createSourceDigest(JSON.stringify(input)).slice('sha256:'.length, 50);
}

function getTemplateBlock(source: string) {
  const openingEnd = source.indexOf('>', source.indexOf('<template')) + 1;
  const closingStart = source.lastIndexOf('</template>');
  return {
    content: source.slice(openingEnd, closingStart),
    start: openingEnd,
    end: closingStart,
  };
}

function createVue2Element(
  source: string,
  tag: string,
  children: unknown[] = [],
  attributes: Record<string, string> = {},
) {
  const start = source.indexOf(`<${tag}`);
  const selfClosingEnd = source.indexOf('/>', start);
  const closingEnd = source.indexOf(`</${tag}>`, start);
  const end = closingEnd >= 0
    ? closingEnd + `</${tag}>`.length
    : selfClosingEnd + 2;
  return {
    type: 1,
    tag,
    start,
    end,
    attrsMap: attributes,
    attrsList: Object.entries(attributes).map(([name, value]) => ({ name, value })),
    children,
  };
}

describe('Vue compiler adapters', () => {
  it('使用 Vue 2.6 vue-template-compiler 范围 AST 注入元素和组件 marker', () => {
    const source = '<script>export default {}</script>\r\n<template>\r\n<div><MyCard /></div>\r\n</template>';
    const compiler = {
      version: '2.6.14',
      parseComponent(sfcSource: string) {
        return { template: getTemplateBlock(sfcSource) };
      },
      compile(templateSource: string) {
        const component = createVue2Element(templateSource, 'MyCard');
        return {
          ast: createVue2Element(templateSource, 'div', [component]),
          errors: [],
        };
      },
    };
    const result = transformVueSfc({
      source,
      filename: 'D:/workspace/src/Legacy.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/Legacy.vue',
      moduleId: 'D:/workspace/src/Legacy.vue',
      compiler: createVue26CompilerAdapter({ compiler }),
      createSourceId,
    });
    const divRecord = result.records.find((record) => record.tagName === 'div');
    const componentRecord = result.records.find((record) => record.tagName === 'MyCard');

    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain(`<div ${SOURCE_ATTRIBUTE}=`);
    expect(result.code).toContain(`<MyCard ${COMPONENT_SOURCE_ATTRIBUTE}=`);
    expect(divRecord?.range.startOffset).toBe(source.indexOf('<div'));
    expect(componentRecord?.parentSourceId).toBe(divRecord?.sourceId);
    expect(result.map?.sources).toEqual(['src/Legacy.vue']);
  });

  it('使用 Vue 2.7 vue/compiler-sfc 的 parseComponent 解析 script setup SFC', () => {
    const source = '<script setup>const ok = true</script>\n<template>\n<section v-if="ok"><span /></section>\n</template>';
    let compileOptions: Record<string, unknown> | null = null;
    let parseCalls = 0;
    let parseComponentCalls = 0;
    const compilerSfc = {
      version: '2.7.16',
      parse() {
        parseCalls += 1;
        return { template: null, errors: [] };
      },
      parseComponent(sfcSource: string) {
        parseComponentCalls += 1;
        const template = getTemplateBlock(sfcSource);
        return {
          template: {
            content: template.content,
            loc: {
              start: { offset: template.start },
              end: { offset: template.end },
            },
          },
          errors: [],
        };
      },
      compileTemplate(options: Record<string, unknown>) {
        compileOptions = options;
        const templateSource = String(options.source);
        const span = createVue2Element(templateSource, 'span');
        return {
          ast: {
            ...createVue2Element(templateSource, 'section', [span], { 'v-if': 'ok' }),
            if: 'ok',
          },
          errors: [],
        };
      },
    };
    const result = transformVueSfc({
      source,
      filename: 'D:/workspace/src/Compat.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/Compat.vue',
      moduleId: 'D:/workspace/src/Compat.vue',
      compiler: createVue27CompilerAdapter({ compilerSfc }),
      createSourceId,
    });
    const sectionRecord = result.records.find((record) => record.tagName === 'section');

    expect(result.diagnostics).toEqual([]);
    expect(sectionRecord?.controlFlow?.kind).toBe('if');
    expect(sectionRecord?.range.startOffset).toBe(source.indexOf('<section'));
    expect(result.code).toContain(`<section v-if="ok" ${SOURCE_ATTRIBUTE}=`);
    expect(parseCalls).toBe(0);
    expect(parseComponentCalls).toBe(1);
    expect(compileOptions).toMatchObject({
      filename: 'D:/workspace/src/Compat.vue',
      compilerOptions: {
        outputSourceRange: true,
      },
    });
  });

  it('保留 Vue 2.7 CRLF 模板原文并补回 compiler trim 的前导 offset', () => {
    const source = '<template>\r\n<div>\r\n  <FirstCard />\r\n  <SecondCard />\r\n</div>\r\n</template>';
    let parseOptions: Record<string, unknown> | null = null;
    let compileOptions: Record<string, unknown> | null = null;
    const compilerSfc = {
      version: '2.7.16',
      parseComponent(sfcSource: string, options: Record<string, unknown>) {
        parseOptions = options;
        return { template: getTemplateBlock(sfcSource), errors: [] };
      },
      compileTemplate(options: Record<string, unknown>) {
        compileOptions = options;
        const compilerSource = String(options.source);
        const firstCard = createVue2Element(compilerSource, 'FirstCard');
        const secondCard = createVue2Element(compilerSource, 'SecondCard');
        return {
          ast: createVue2Element(compilerSource, 'div', [
            firstCard,
            { type: 2, text: '{{ label }}' },
            secondCard,
          ]),
          errors: [],
        };
      },
    };
    const result = transformVueSfc({
      source,
      filename: 'D:/workspace/src/Crlf.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/Crlf.vue',
      moduleId: 'D:/workspace/src/Crlf.vue',
      compiler: createVue27CompilerAdapter({ compilerSfc }),
      createSourceId,
    });
    const secondCardRecord = result.records.find((record) => record.tagName === 'SecondCard');

    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain(`<SecondCard ${COMPONENT_SOURCE_ATTRIBUTE}=`);
    expect(secondCardRecord?.range.startOffset).toBe(source.indexOf('<SecondCard'));
    expect(parseOptions).toMatchObject({ deindent: false });
    expect(compileOptions).toMatchObject({ source: '<div>\r\n  <FirstCard />\r\n  <SecondCard />\r\n</div>' });
  });

  it('允许 Vue 2 空白 template 不返回 AST', () => {
    const source = '<template>\r\n  \r\n</template>';
    const compilerSfc = {
      version: '2.7.16',
      parseComponent(sfcSource: string) {
        return { template: getTemplateBlock(sfcSource), errors: [] };
      },
      compileTemplate() {
        return { errors: [] };
      },
    };
    const result = transformVueSfc({
      source,
      filename: 'D:/workspace/src/Empty.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/Empty.vue',
      moduleId: 'D:/workspace/src/Empty.vue',
      compiler: createVue27CompilerAdapter({ compilerSfc }),
      createSourceId,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.transformed).toBe(false);
    expect(result.records).toEqual([]);
  });

  it('读取 Vue 2 compiler 错误对象的 msg 字段', () => {
    const source = '<template><div /></template>';
    const compilerSfc = {
      version: '2.7.16',
      parseComponent(sfcSource: string) {
        return { template: getTemplateBlock(sfcSource), errors: [] };
      },
      compileTemplate() {
        return { errors: [{ msg: '模板语法错误', start: 0, end: 5 }] };
      },
    };
    const result = transformVueSfc({
      source,
      filename: 'D:/workspace/src/Invalid.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/Invalid.vue',
      moduleId: 'D:/workspace/src/Invalid.vue',
      compiler: createVue27CompilerAdapter({ compilerSfc }),
      createSourceId,
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'TEMPLATE_PARSE_ERROR', message: '模板语法错误' }),
    ]);
  });

  it('忽略 Vue 2.7 SFC 分块解析器对 HTML void 标签的假闭合错误', () => {
    const source = '<template><div><img :src="url"></div></template>';
    const compilerSfc = {
      version: '2.7.16',
      parseComponent(sfcSource: string) {
        const template = getTemplateBlock(sfcSource);
        return {
          template: {
            content: template.content,
            loc: {
              start: { offset: template.start },
              end: { offset: template.end },
            },
          },
          errors: ['tag <img> has no matching end tag.'],
        };
      },
      compileTemplate(options: Record<string, unknown>) {
        const templateSource = String(options.source);
        const imageStart = templateSource.indexOf('<img');
        const imageEnd = templateSource.indexOf('>', imageStart) + 1;
        return {
          ast: createVue2Element(templateSource, 'div', [{
            type: 1,
            tag: 'img',
            start: imageStart,
            end: imageEnd,
            attrsMap: { ':src': 'url' },
            attrsList: [{ name: ':src', value: 'url' }],
            children: [],
          }]),
          errors: [],
        };
      },
    };
    const result = transformVueSfc({
      source,
      filename: 'D:/workspace/src/VoidTag.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/VoidTag.vue',
      moduleId: 'D:/workspace/src/VoidTag.vue',
      compiler: createVue27CompilerAdapter({ compilerSfc }),
      createSourceId,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.code).toMatch(/<img :src="url" data-wsi-source=/);
  });
});
