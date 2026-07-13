// Webpack 4 不识别 package exports，需要保留可按物理子路径解析的 ESM wrapper。
export * from './dist/browser-runtime.js';
