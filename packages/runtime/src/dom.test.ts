// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findSourceCandidate, isShortcut } from './dom';
import { COMPONENT_SOURCE_ATTRIBUTE, SOURCE_ATTRIBUTE } from './types';

function pointerEvent(path: EventTarget[]): PointerEvent {
  const event = new PointerEvent('pointermove', { clientX: 10, clientY: 12 });
  vi.spyOn(event, 'composedPath').mockReturnValue(path);
  return event;
}

describe('findSourceCandidate', () => {
  let inspectorHost: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => []
    });
    inspectorHost = document.createElement('div');
    document.body.append(inspectorHost);
  });

  it('识别带 marker 的 SVG 元素', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute(SOURCE_ATTRIBUTE, 'source_svg_1234');
    svg.append(circle);
    document.body.append(svg);

    const candidate = findSourceCandidate(
      pointerEvent([circle, svg, document.body, document.documentElement, document]),
      SOURCE_ATTRIBUTE,
      inspectorHost,
      COMPONENT_SOURCE_ATTRIBUTE
    );
    expect(candidate).toMatchObject({ element: circle, sourceId: 'source_svg_1234', kind: 'element' });
  });

  it('DOM 无精确 marker 时从 Vue owner 读取组件调用点', () => {
    const target = document.createElement('span') as HTMLSpanElement & {
      __vueParentComponent?: unknown;
    };
    target.__vueParentComponent = {
      vnode: { props: { [COMPONENT_SOURCE_ATTRIBUTE]: 'component_call_1234' } },
      parent: null
    };
    document.body.append(target);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [target]
    });

    const candidate = findSourceCandidate(
      pointerEvent([target, document.body, document.documentElement, document]),
      SOURCE_ATTRIBUTE,
      inspectorHost,
      COMPONENT_SOURCE_ATTRIBUTE
    );
    expect(candidate).toMatchObject({ element: target, sourceId: 'component_call_1234', kind: 'component' });
  });

  it('从 Vue 2 占位 VNode 读取组件调用点', () => {
    const target = document.createElement('span') as HTMLSpanElement & {
      __vue__?: unknown;
    };
    target.__vue__ = {
      $vnode: {
        data: {
          attrs: { [COMPONENT_SOURCE_ATTRIBUTE]: 'vue2_component_call_1234' }
        }
      },
      $parent: null
    };
    document.body.append(target);

    const candidate = findSourceCandidate(
      pointerEvent([target, document.body, document.documentElement, document]),
      SOURCE_ATTRIBUTE,
      inspectorHost,
      COMPONENT_SOURCE_ATTRIBUTE
    );

    expect(candidate).toMatchObject({
      element: target,
      sourceId: 'vue2_component_call_1234',
      kind: 'component'
    });
  });

  it('沿 Vue 2 $parent 链读取 inheritAttrs=false 调用点', () => {
    const target = document.createElement('span') as HTMLSpanElement & {
      __vue__?: unknown;
    };
    target.__vue__ = {
      $vnode: { data: {} },
      $parent: {
        $attrs: { [COMPONENT_SOURCE_ATTRIBUTE]: 'vue2_parent_call_1234' },
        $parent: null
      }
    };
    document.body.append(target);

    const candidate = findSourceCandidate(
      pointerEvent([target, document.body, document.documentElement, document]),
      SOURCE_ATTRIBUTE,
      inspectorHost,
      COMPONENT_SOURCE_ATTRIBUTE
    );

    expect(candidate).toMatchObject({
      element: target,
      sourceId: 'vue2_parent_call_1234',
      kind: 'component'
    });
  });

  it('直接读取已落到 DOM 的组件调用 marker', () => {
    const customElement = document.createElement('demo-widget');
    customElement.setAttribute(COMPONENT_SOURCE_ATTRIBUTE, 'component_dom_1234');
    document.body.append(customElement);
    const candidate = findSourceCandidate(
      pointerEvent([customElement, document.body, document.documentElement, document]),
      SOURCE_ATTRIBUTE,
      inspectorHost,
      COMPONENT_SOURCE_ATTRIBUTE
    );
    expect(candidate).toMatchObject({
      element: customElement,
      sourceId: 'component_dom_1234',
      kind: 'component'
    });
  });

  it('Shift 命中时优先组件调用 marker', () => {
    const componentRoot = document.createElement('section');
    componentRoot.setAttribute(SOURCE_ATTRIBUTE, 'component_internal_1');
    componentRoot.setAttribute(COMPONENT_SOURCE_ATTRIBUTE, 'component_caller_1');
    const child = document.createElement('span');
    child.setAttribute(SOURCE_ATTRIBUTE, 'child_internal_123');
    componentRoot.append(child);
    document.body.append(componentRoot);
    const event = new PointerEvent('pointermove', { shiftKey: true });
    vi.spyOn(event, 'composedPath').mockReturnValue([
      child,
      componentRoot,
      document.body,
      document.documentElement,
      document
    ]);

    expect(findSourceCandidate(
      event,
      SOURCE_ATTRIBUTE,
      inspectorHost,
      COMPONENT_SOURCE_ATTRIBUTE
    )).toMatchObject({ sourceId: 'component_caller_1', kind: 'component' });
  });

  it('Shift 命中 inheritAttrs false 元素时优先 Vue owner 调用点', () => {
    const target = document.createElement('span') as HTMLSpanElement & {
      __vueParentComponent?: unknown;
    };
    target.setAttribute(SOURCE_ATTRIBUTE, 'no_inherit_internal');
    target.__vueParentComponent = {
      vnode: { props: { [COMPONENT_SOURCE_ATTRIBUTE]: 'no_inherit_caller' } },
      parent: null
    };
    document.body.append(target);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [target]
    });
    const event = new PointerEvent('pointermove', { shiftKey: true });
    vi.spyOn(event, 'composedPath').mockReturnValue([
      target,
      document.body,
      document.documentElement,
      document
    ]);

    expect(findSourceCandidate(
      event,
      SOURCE_ATTRIBUTE,
      inspectorHost,
      COMPONENT_SOURCE_ATTRIBUTE
    )).toMatchObject({ sourceId: 'no_inherit_caller', kind: 'component' });
  });

  it('忽略 Inspector 自身 Shadow DOM 路径', () => {
    const button = document.createElement('button');
    button.setAttribute(SOURCE_ATTRIBUTE, 'should_not_match');
    inspectorHost.append(button);
    expect(findSourceCandidate(
      pointerEvent([button, inspectorHost, document.body, document.documentElement, document]),
      SOURCE_ATTRIBUTE,
      inspectorHost,
      COMPONENT_SOURCE_ATTRIBUTE
    )).toBeNull();
  });
});

describe('isShortcut', () => {
  it('严格匹配修饰键和主键', () => {
    expect(isShortcut(new KeyboardEvent('keydown', { key: 'C', altKey: true, shiftKey: true }), 'Alt+Shift+C')).toBe(true);
    expect(isShortcut(new KeyboardEvent('keydown', { key: 'C', altKey: true }), 'Alt+Shift+C')).toBe(false);
  });
});
