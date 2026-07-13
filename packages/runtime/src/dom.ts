import type { SourceCandidate } from './types';

interface Vue3ComponentInstanceLike {
  parent?: Vue3ComponentInstanceLike | null;
  vnode?: {
    props?: Record<string, unknown> | null;
  };
}

interface Vue2ComponentInstanceLike {
  $attrs?: Record<string, unknown> | null;
  $parent?: Vue2ComponentInstanceLike | null;
  $vnode?: {
    data?: {
      attrs?: Record<string, unknown> | null;
      props?: Record<string, unknown> | null;
    } | null;
  } | null;
}

interface VueElement extends Element {
  __vueParentComponent?: Vue3ComponentInstanceLike;
  __vue__?: Vue2ComponentInstanceLike;
}

function readSourceId(element: Element, attributeName: string): string | null {
  const value = element.getAttribute(attributeName);
  return value && value.length <= 128 ? value : null;
}

function readRecordSourceId(
  record: Record<string, unknown> | null | undefined,
  attributeName: string
): string | null {
  const value = record?.[attributeName];
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value
    : null;
}

function fromVue3Owner(element: VueElement, attributeName: string): SourceCandidate | null {
  let instance: Vue3ComponentInstanceLike | null | undefined = element.__vueParentComponent;
  let depth = 0;

  while (instance && depth < 64) {
    const sourceId = readRecordSourceId(instance.vnode?.props, attributeName);
    if (sourceId) {
      return { element, sourceId, kind: 'component' };
    }
    instance = instance.parent;
    depth += 1;
  }

  return null;
}

function fromVue2Owner(element: VueElement, attributeName: string): SourceCandidate | null {
  let instance: Vue2ComponentInstanceLike | null | undefined = element.__vue__;
  let depth = 0;

  while (instance && depth < 64) {
    // Vue 2 的组件调用属性保留在占位 VNode；inheritAttrs=false 时也可从 $attrs 读取。
    const sourceId = readRecordSourceId(instance.$vnode?.data?.attrs, attributeName)
      || readRecordSourceId(instance.$vnode?.data?.props, attributeName)
      || readRecordSourceId(instance.$attrs, attributeName);
    if (sourceId) {
      return { element, sourceId, kind: 'component' };
    }
    instance = instance.$parent;
    depth += 1;
  }

  return null;
}

function fromVueOwner(element: VueElement, attributeName: string): SourceCandidate | null {
  return fromVue3Owner(element, attributeName)
    || fromVue2Owner(element, attributeName);
}

export function findSourceCandidate(
  event: PointerEvent,
  attributeName: string,
  inspectorHost: HTMLElement,
  componentAttributeName = 'data-wsi-component-source'
): SourceCandidate | null {
  const path = event.composedPath();
  if (path.includes(inspectorHost)) {
    return null;
  }

  const pathElements = path.filter((target): target is Element => target instanceof Element);
  const pointElements = document.elementsFromPoint(event.clientX, event.clientY);
  if (event.shiftKey) {
    for (const element of pathElements) {
      const componentSourceId = readSourceId(element, componentAttributeName);
      if (componentSourceId) {
        return { element, sourceId: componentSourceId, kind: 'component' };
      }
    }
    for (const element of pathElements) {
      const ownerCandidate = fromVueOwner(element as VueElement, componentAttributeName);
      if (ownerCandidate) {
        return ownerCandidate;
      }
    }
    for (const element of pointElements) {
      if (inspectorHost.contains(element)) {
        continue;
      }
      const componentSourceId = readSourceId(element, componentAttributeName);
      if (componentSourceId) {
        return { element, sourceId: componentSourceId, kind: 'component' };
      }
      const ownerCandidate = fromVueOwner(element as VueElement, componentAttributeName);
      if (ownerCandidate) {
        return ownerCandidate;
      }
    }
  }

  for (const element of pathElements) {
    const sourceId = readSourceId(element, attributeName);
    if (sourceId) {
      return { element, sourceId, kind: 'element' };
    }
  }

  for (const element of pathElements) {
    const componentSourceId = readSourceId(element, componentAttributeName);
    if (componentSourceId) {
      return { element, sourceId: componentSourceId, kind: 'component' };
    }
  }

  for (const element of pointElements) {
    if (inspectorHost.contains(element)) {
      continue;
    }
    const sourceId = readSourceId(element, attributeName);
    if (sourceId) {
      return { element, sourceId, kind: 'element' };
    }
  }

  for (const element of pathElements) {
    const ownerCandidate = fromVueOwner(element as VueElement, componentAttributeName);
    if (ownerCandidate) {
      return ownerCandidate;
    }
  }

  for (const element of pointElements) {
    if (inspectorHost.contains(element)) {
      continue;
    }
    const componentSourceId = readSourceId(element, componentAttributeName);
    if (componentSourceId) {
      return { element, sourceId: componentSourceId, kind: 'component' };
    }
    const ownerCandidate = fromVueOwner(element as VueElement, componentAttributeName);
    if (ownerCandidate) {
      return ownerCandidate;
    }
  }

  return null;
}

export function isShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split('+').map((part) => part.trim());
  const key = parts.at(-1);
  return Boolean(
    key
      && event.key.toLowerCase() === key
      && event.altKey === parts.includes('alt')
      && event.shiftKey === parts.includes('shift')
      && event.ctrlKey === parts.includes('ctrl')
      && event.metaKey === parts.includes('meta')
  );
}
