import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WebSourceInspectorWebpackPlugin as InternalWebpackPlugin,
} from '@web-source-inspector/adapter-webpack';

export {
  WEBPACK_RUNTIME_GUARD,
  WebpackAdapterError,
  createRawLoopbackBrowserTransport,
  createRuntimeBootstrapSource,
  createWebSourceInspectorBrowserMiddleware,
  getWebSourceInspectorBrowserTransportDescriptor,
  parseVueTemplateQuery,
} from '@web-source-inspector/adapter-webpack';
export type {
  ConnectMiddleware,
  RawLoopbackBrowserTransport,
  RawLoopbackBrowserTransportOptions,
  RawLoopbackTransportDescriptor,
  VueLoaderMajor,
  VueTemplateQuery,
  WebSourceInspectorWebpackPluginOptions,
  WebpackBrowserClientContext,
  WebpackBrowserMessageHandler,
} from '@web-source-inspector/adapter-webpack';

// ESM 直接使用模块 URL；CJS 构建会在编译期替换为当前输出文件的 URL。
const currentFilename = fileURLToPath(import.meta.url);
const publicLoaderPath = path.join(path.dirname(currentFilename), 'webpack-loader.cjs');

export class WebSourceInspectorWebpackPlugin extends InternalWebpackPlugin {
  static override readonly loaderPath = publicLoaderPath;
  static override readonly runtimeModuleRequest = 'web-source-inspector/browser-runtime';
}

export default WebSourceInspectorWebpackPlugin;
