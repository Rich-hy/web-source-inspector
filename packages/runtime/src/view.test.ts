// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserMetadataPayload } from './types';
import { createInspectorView } from './view';

afterEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('InspectorView tooltip', () => {
  it('只显示 DOM、组件和选择状态，不显示源码路径或行列', () => {
    const view = createInspectorView('bottom-right', 'zh-CN');
    const target = document.createElement('button');
    document.body.append(target);

    view.setConnection('connected', 'Cursor');
    view.setMode('armed');
    view.showCandidate({
      element: target,
      sourceId: 'source_tooltip_target_1234',
      kind: 'component'
    });
    view.showMetadata({
      protocolVersion: '1.0',
      sessionId: 'session_runtime_1234',
      pageClientId: 'page_runtime_1234',
      timestamp: Date.now(),
      sourceId: 'source_tooltip_target_1234',
      tagName: 'button',
      componentName: 'PrimaryButton',
      relativePath: 'src/private/PrimaryButton.vue',
      line: 42,
      column: 7
    } as BrowserMetadataPayload);

    const tooltip = view.host.shadowRoot?.querySelector<HTMLElement>('.wsi-tooltip');
    expect(tooltip?.textContent).toContain('<button> · PrimaryButton');
    expect(tooltip?.textContent).toContain('点击定位');
    expect(tooltip?.textContent).not.toContain('PrimaryButton.vue');
    expect(tooltip?.textContent).not.toContain('42');

    view.setMode('opening');
    expect(tooltip?.textContent).toContain('正在打开');
    view.dispose();
  });
});
