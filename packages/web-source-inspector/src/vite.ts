import {
  webSourceInspector as createViteAdapter,
  type WebSourceInspectorOptions,
} from '@web-source-inspector/vite-plugin';

export type {
  BrowserAccessMode,
  WebSourceInspectorOptions,
} from '@web-source-inspector/vite-plugin';

export function webSourceInspector(options: WebSourceInspectorOptions = {}) {
  return createViteAdapter(options, {
    runtimeModuleId: 'web-source-inspector/browser-runtime',
  });
}

export default webSourceInspector;
