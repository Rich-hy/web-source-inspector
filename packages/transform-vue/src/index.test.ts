import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as compilerDom from '@vue/compiler-dom';
import * as compilerSfc from '@vue/compiler-sfc';
import {
  createSourceDigest,
  createSourceIdGenerator,
  SourceManifest,
} from '@web-source-inspector/compiler-core';

import {
  COMPONENT_SOURCE_ATTRIBUTE,
  SOURCE_ATTRIBUTE,
  createVue3CompilerAdapter,
  transformVueSfc,
  type TransformVueSfcOptions,
  type VueSourceIdInput,
} from './index.js';

const vue3Compiler = createVue3CompilerAdapter({
  compilerSfc,
  compilerDom,
});

function transform(
  source: string,
  overrides: Partial<Omit<TransformVueSfcOptions, 'source' | 'createSourceId'>> = {},
) {
  return transformVueSfc({
    source,
    filename: 'D:/workspace/src/Demo.vue',
    rootKey: 'workspace-root',
    relativePath: 'src/Demo.vue',
    moduleId: 'D:/workspace/src/Demo.vue',
    moduleGeneration: 4,
    compiler: vue3Compiler,
    createSourceId: deterministicSourceId,
    ...overrides,
  });
}

function deterministicSourceId(input: VueSourceIdInput): string {
  return createSourceDigest(JSON.stringify(input)).slice('sha256:'.length, 50);
}

describe('transformVueSfc', () => {
  it('兼容旧调用形式并从指定项目目录解析同版本 Vue 3 compiler', () => {
    const source = '<template><main /></template>';
    const result = transformVueSfc({
      source,
      filename: 'D:/workspace/src/Demo.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/Demo.vue',
      moduleId: 'D:/workspace/src/Demo.vue',
      compilerRoot: fileURLToPath(new URL('..', import.meta.url)),
      vueVersion: compilerSfc.version,
      createSourceId: deterministicSourceId,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain(`<main ${SOURCE_ATTRIBUTE}=`);
  });

  it('拒绝与实际 vue/package.json 不一致的显式 Vue 版本', () => {
    const result = transformVueSfc({
      source: '<template><main /></template>',
      filename: 'D:/workspace/src/Demo.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/Demo.vue',
      moduleId: 'D:/workspace/src/Demo.vue',
      compilerRoot: fileURLToPath(new URL('..', import.meta.url)),
      vueVersion: '3.0.0',
      createSourceId: deterministicSourceId,
    });

    expect(result.transformed).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'COMPILER_RESOLUTION_ERROR' }),
    ]);
  });

  it('注入原生元素和组件，并保留父级与组件调用点候选', () => {
    const source = `<script setup lang="ts">
const onClick = () => undefined
</script>

<template>
  <main id="root" :class="{ active: true }" @click="onClick">
    <MyCard title="card">
      <span ref="label">hello</span>
    </MyCard>
  </main>
</template>
`;

    const result = transform(source);
    const mainRecord = result.records.find((record) => record.tagName === 'main');
    const cardRecord = result.records.find((record) => record.tagName === 'MyCard');
    const spanRecord = result.records.find((record) => record.tagName === 'span');

    expect(result.transformed).toBe(true);
    expect(result.moduleId).toBe('D:/workspace/src/Demo.vue');
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain(
      `<main id="root" :class="{ active: true }" @click="onClick" ${SOURCE_ATTRIBUTE}=`,
    );
    expect(result.code).toContain(
      `<MyCard title="card" ${COMPONENT_SOURCE_ATTRIBUTE}=`,
    );
    expect(result.code).toContain(`<span ref="label" ${SOURCE_ATTRIBUTE}=`);
    expect(mainRecord?.kind).toBe('element');
    expect(cardRecord?.kind).toBe('component');
    expect(cardRecord?.parentSourceId).toBe(mainRecord?.sourceId);
    expect(spanRecord?.parentSourceId).toBe(cardRecord?.sourceId);
    expect(mainRecord?.generation).toBe(4);
    expect(mainRecord?.accuracy).toBe('exact');
    expect(mainRecord?.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(cardRecord?.accuracy).toBe('approximate');
    expect(mainRecord?.range.startOffset).toBe(source.indexOf('<main'));
    expect(mainRecord?.range.endOffset).toBe(source.indexOf('</main>') + '</main>'.length);
    expect(mainRecord?.componentName).toBe('Demo');
    expect(result.map?.sourcesContent).toEqual([source]);
    expect(result.map?.sources).toEqual(['src/Demo.vue']);
    expect(result.map?.mappings.length).toBeGreaterThan(0);
  });

  it('记录多根 Fragment、template 控制流、条件分支和动态组件', () => {
    const source = `<template>
  <template v-for="item in items" :key="item.id">
    <section v-if="item.visible">{{ item.name }}</section>
    <section v-else>hidden</section>
  </template>
  <Teleport to="body"><div class="dialog" /></Teleport>
  <component :is="currentView" />
</template>`;

    const result = transform(source);
    const rootFragment = result.records.find((record) => record.tagName === '#fragment');
    const templateRecord = result.records.find((record) => record.tagName === 'template');
    const sections = result.records.filter((record) => record.tagName === 'section');
    const teleportRecord = result.records.find((record) => record.tagName === 'Teleport');
    const dialogRecord = result.records.find((record) => record.tagName === 'div');
    const dynamicRecord = result.records.find((record) => record.tagName === 'component');

    expect(rootFragment?.kind).toBe('fragment');
    expect(templateRecord?.kind).toBe('fragment');
    expect(templateRecord?.parentSourceId).toBe(rootFragment?.sourceId);
    expect(templateRecord?.controlFlow?.kind).toBe('for');
    expect(sections[0]?.controlFlow?.kind).toBe('if');
    expect(sections[1]?.controlFlow?.kind).toBe('else');
    expect(sections[0]?.parentSourceId).toBe(templateRecord?.sourceId);
    expect(teleportRecord?.kind).toBe('component');
    expect(dialogRecord?.parentSourceId).toBe(teleportRecord?.sourceId);
    expect(dynamicRecord?.kind).toBe('dynamic');
    expect(result.code).not.toMatch(/<Teleport[^>]+data-wsi-source/);
    expect(result.code).toMatch(
      /<div class="dialog" data-wsi-source="[A-Za-z0-9_-]+"/,
    );
    expect(result.code).toMatch(
      /<component :is="currentView" data-wsi-component-source="[A-Za-z0-9_-]+"/,
    );
  });

  it('按完整 SFC 的 UTF-16 offset 计算 BOM、CRLF、中文和 emoji 坐标', () => {
    const source = `\uFEFF<script setup>const icon = '😀'</script>\r\n<template>\r\n\t<div title="😀">中文</div>\r\n</template>\r\n`;
    const result = transform(source, {
      filename: 'D:/工作 空间/src/中文组件.vue',
      relativePath: 'src/中文组件.vue',
      moduleId: 'D:/工作 空间/src/中文组件.vue',
    });
    const record = result.records.find((candidate) => candidate.tagName === 'div');
    const startOffset = source.indexOf('<div');
    const endOffset = source.indexOf('</div>') + '</div>'.length;
    const elementLine = `\t<div title="😀">中文</div>`;

    expect(record?.range).toEqual({
      startLine: 3,
      startColumn: 2,
      endLine: 3,
      endColumn: elementLine.length + 1,
      startOffset,
      endOffset,
    });
    expect(source.slice(record?.range.startOffset, record?.range.endOffset)).toBe(
      '<div title="😀">中文</div>',
    );
    expect(result.map?.sources).toEqual(['src/中文组件.vue']);
  });

  it('统一 Windows 相对路径后再生成 sourceId 和记录', () => {
    const capturedInputs: VueSourceIdInput[] = [];
    const source = `<template><div /></template>`;
    const result = transformVueSfc({
      source,
      filename: 'D:\\workspace\\src\\Demo.vue',
      rootKey: 'workspace-root',
      relativePath: 'src\\views\\Demo.vue',
      moduleId: 'D:/workspace/src/Demo.vue',
      compiler: vue3Compiler,
      createSourceId(input) {
        capturedInputs.push(input);
        return deterministicSourceId(input);
      },
    });

    expect(capturedInputs[0]?.normalizedRelativePath).toBe('src/views/Demo.vue');
    expect(result.records[0]?.relativePath).toBe('src/views/Demo.vue');
  });

  it('与 core HMAC 生成器保持稳定性和 generation 失效语义', () => {
    const source = `<template><main><span /></main></template>`;
    const createSourceId = createSourceIdGenerator('0123456789abcdef0123456789abcdef');
    const baseOptions: TransformVueSfcOptions = {
      source,
      filename: 'D:/workspace/src/Demo.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/Demo.vue',
      moduleId: 'D:/workspace/src/Demo.vue',
      moduleGeneration: 1,
      compiler: vue3Compiler,
      createSourceId,
    };
    const first = transformVueSfc(baseOptions);
    const second = transformVueSfc(baseOptions);
    const nextGeneration = transformVueSfc({
      ...baseOptions,
      moduleGeneration: 2,
    });

    expect(first.records.map((record) => record.sourceId)).toEqual(
      second.records.map((record) => record.sourceId),
    );
    expect(first.records.map((record) => record.sourceId)).not.toEqual(
      nextGeneration.records.map((record) => record.sourceId),
    );
  });

  it('记录 slot 候选但只给 fallback DOM 注入 marker', () => {
    const source = `<template><slot name="header"><h1>fallback</h1></slot></template>`;
    const result = transform(source);
    const slotRecord = result.records.find((record) => record.kind === 'slot');
    const fallbackRecord = result.records.find((record) => record.tagName === 'h1');

    expect(slotRecord?.tagName).toBe('slot');
    expect(fallbackRecord?.parentSourceId).toBe(slotRecord?.sourceId);
    expect(result.code).not.toMatch(/<slot[^>]+data-wsi-source/);
    expect(result.code).toMatch(/<h1 data-wsi-source="[A-Za-z0-9_-]+"/);
  });

  it('分离组件调用点 marker，避免 attrs fallthrough 覆盖内部精确 DOM marker', () => {
    const source = `<template><MyCard><span>content</span></MyCard></template>`;
    const result = transform(source);

    expect(result.code).toMatch(
      /<MyCard data-wsi-component-source="[A-Za-z0-9_-]+">/,
    );
    expect(result.code).toMatch(/<span data-wsi-source="[A-Za-z0-9_-]+">/);
    expect(result.code).not.toMatch(/<MyCard data-wsi-source=/);
  });

  it('Manifest 碰撞时不提交记录且不写入 marker', () => {
    const manifest = new SourceManifest();
    const collidingSourceId = 'a'.repeat(43);
    const firstModuleId = 'D:/workspace/src/First.vue';
    const secondModuleId = 'D:/workspace/src/Second.vue';
    const first = transformVueSfc({
      source: '<template><div /></template>',
      filename: firstModuleId,
      rootKey: 'workspace-root',
      relativePath: 'src/First.vue',
      moduleId: firstModuleId,
      moduleGeneration: 1,
      compiler: vue3Compiler,
      createSourceId: () => collidingSourceId,
      finalizeRecords: (records) =>
        manifest.replaceModule(firstModuleId, 1, records).records,
    });
    const second = transformVueSfc({
      source: '<template><span /></template>',
      filename: secondModuleId,
      rootKey: 'workspace-root',
      relativePath: 'src/Second.vue',
      moduleId: secondModuleId,
      moduleGeneration: 1,
      compiler: vue3Compiler,
      createSourceId: () => collidingSourceId,
      finalizeRecords: (records) =>
        manifest.replaceModule(secondModuleId, 1, records).records,
    });
    expect(first.records[0]?.sourceId).toBe(collidingSourceId);
    expect(second.records).toEqual([]);
    expect(second.code).toBe('<template><span /></template>');
    expect(second.transformed).toBe(false);
    expect(second.diagnostics).toEqual([
      expect.objectContaining({
        code: 'SOURCE_ID_COLLISION',
        severity: 'error',
      }),
    ]);
    expect(manifest.resolve(collidingSourceId)).toMatchObject({
      status: 'found',
      record: { moduleId: firstModuleId },
    });
  });

  it('模块内不同节点发生 sourceId 碰撞时原子失败', () => {
    const collidingSourceId = 'a'.repeat(43);
    const source = '<template><main><span /></main></template>';
    const result = transformVueSfc({
      source,
      filename: 'D:/workspace/src/Demo.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/Demo.vue',
      moduleId: 'D:/workspace/src/Demo.vue',
      moduleGeneration: 1,
      compiler: vue3Compiler,
      createSourceId: () => collidingSourceId,
    });

    expect(result.code).toBe(source);
    expect(result.records).toEqual([]);
    expect(result.transformed).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'SOURCE_ID_COLLISION',
        severity: 'error',
      }),
    ]);
  });

  it('拒绝被截断的非完整 sourceId', () => {
    const source = '<template><main /></template>';
    const result = transformVueSfc({
      source,
      filename: 'D:/workspace/src/Demo.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/Demo.vue',
      moduleId: 'D:/workspace/src/Demo.vue',
      compiler: vue3Compiler,
      createSourceId: () => 'a'.repeat(42),
    });

    expect(result.code).toBe(source);
    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'SOURCE_ID_ERROR', severity: 'error' }),
    ]);
  });

  it('处理自闭合 SVG，并避免覆盖用户已占用的保留属性', () => {
    const source = `<template>
  <svg viewBox="0 0 10 10"><path d="M0 0L10 10" /></svg>
  <button data-wsi-source="business-value">Save</button>
</template>`;
    const result = transform(source);

    expect(result.code).toMatch(
      /<path d="M0 0L10 10" data-wsi-source="[A-Za-z0-9_-]+" \/>/,
    );
    expect(result.code).toContain('data-wsi-source="business-value"');
    expect(result.code.match(/data-wsi-source="business-value"/g)).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'RESERVED_ATTRIBUTE_CONFLICT',
        severity: 'warning',
      }),
    ]);
  });

  it('无 template 时返回明确诊断且不改源码', () => {
    const source = `<script setup lang="ts">const value = 1</script>`;
    let finalized = false;
    const result = transform(source, {
      finalizeRecords(records) {
        finalized = true;
        expect(records).toEqual([]);
        return records;
      },
    });

    expect(finalized).toBe(true);
    expect(result.code).toBe(source);
    expect(result.records).toEqual([]);
    expect(result.transformed).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'NO_TEMPLATE', severity: 'info' }),
    ]);
  });

  it('不支持的 template lang 明确降级且不做字符串注入', () => {
    const source = `<template lang="pug">\ndiv hello\n</template>`;
    const result = transform(source);

    expect(result.code).toBe(source);
    expect(result.records).toEqual([]);
    expect(result.transformed).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNSUPPORTED_TEMPLATE_LANG',
        severity: 'warning',
      }),
    ]);
  });

  it('sourceId 生成失败时原子返回未修改源码', () => {
    const source = `<template><div><span /></div></template>`;
    let calls = 0;
    const result = transformVueSfc({
      source,
      filename: 'D:/workspace/src/Demo.vue',
      rootKey: 'workspace-root',
      relativePath: 'src/Demo.vue',
      moduleId: 'D:/workspace/src/Demo.vue',
      compiler: vue3Compiler,
      createSourceId() {
        calls += 1;
        if (calls === 2) {
          throw new Error('generator failed');
        }
        return 'a'.repeat(43);
      },
    });

    expect(result.code).toBe(source);
    expect(result.records).toEqual([]);
    expect(result.transformed).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'SOURCE_ID_ERROR', severity: 'error' }),
    ]);
  });

  it('模板解析失败时不提交 records，保留上一代可运行 Manifest', () => {
    let finalizeCalls = 0;
    const source = '<template><div></template>';
    const result = transform(source, {
      finalizeRecords(records) {
        finalizeCalls += 1;
        return records;
      },
    });

    expect(finalizeCalls).toBe(0);
    expect(result.code).toBe(source);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'SFC_PARSE_ERROR', severity: 'error' }),
    ]);
  });
});
