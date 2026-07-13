import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ESM 直接使用模块 URL；被公开包打入 CJS 时由构建配置替换模块 URL。
const currentFilename = fileURLToPath(import.meta.url);

export const webpackLoaderPath = path.join(path.dirname(currentFilename), 'loader.js');
