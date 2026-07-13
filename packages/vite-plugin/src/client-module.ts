import type { ResolvedInspectorOptions } from './types';
import type { ResolvedInspectorAssets } from './types';

export const VIRTUAL_CLIENT_ID = 'virtual:web-source-inspector/client';
export const RESOLVED_VIRTUAL_CLIENT_ID = '\0web-source-inspector:client';
export const VIRTUAL_RUNTIME_ID = 'virtual:web-source-inspector/runtime';
export const RESOLVED_VIRTUAL_RUNTIME_ID = '\0web-source-inspector:runtime';

export function createRuntimeModule(assets: ResolvedInspectorAssets): string {
  if (assets.runtimeModuleSource !== undefined) {
    return assets.runtimeModuleSource;
  }
  return `export { createInspectorRuntime } from ${JSON.stringify(assets.runtimeModuleId)};\n`;
}

export function createClientModule(
  sessionId: string,
  browserToken: string,
  options: ResolvedInspectorOptions['ui'],
): string {
  const runtimeOptions = JSON.stringify({
    sessionId,
    browserToken,
    buttonPosition: options.buttonPosition,
    shortcut: options.shortcut,
    singleShot: options.singleShot,
    language: options.language
  });

  return `
import { createInspectorRuntime } from '${VIRTUAL_RUNTIME_ID}';

const hot = import.meta.hot;
const globalKey = '__WEB_SOURCE_INSPECTOR_RUNTIME__';

if (hot) {
  globalThis[globalKey]?.dispose?.('hmr');
  let disposed = false;
  const transport = {
    send(event, payload) {
      if (!disposed) {
        hot.send(event, payload);
      }
    },
    on(event, listener) {
      if (disposed) {
        return () => undefined;
      }
      hot.on(event, listener);
      return () => hot.off(event, listener);
    },
    dispose() {
      disposed = true;
    }
  };
  const runtime = createInspectorRuntime({ ...${runtimeOptions}, transport });
  globalThis[globalKey] = runtime;
  hot.dispose(() => {
    runtime.dispose('hmr');
    if (globalThis[globalKey] === runtime) {
      delete globalThis[globalKey];
    }
  });
}
`;
}
