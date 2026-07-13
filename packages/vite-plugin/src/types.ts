import type { ButtonPosition } from '@web-source-inspector/runtime';
import type { VueCompilerAdapter } from '@web-source-inspector/transform-vue';

export interface WebSourceInspectorAssets {
  /** 公开包可注入已编译的 Browser Runtime ESM 字符串。 */
  runtimeModuleSource?: string;
  /** 未注入源码时使用的稳定公开 ESM 入口。 */
  runtimeModuleId?: string;
}

export interface WebSourceInspectorOptions {
  enabled?: boolean;
  workspaceRoot?: string;
  sourceRoots?: string[];
  include?: Array<string | RegExp>;
  exclude?: Array<string | RegExp>;
  bridge?: boolean;
  remoteBrowser?: false;
  debugLog?: boolean;
  /** 高级集成可注入 bundler 实际使用的 Vue compiler。 */
  compiler?: VueCompilerAdapter;
  ui?: boolean | {
    buttonPosition?: ButtonPosition;
    shortcut?: string | false;
    singleShot?: boolean;
    language?: 'zh-CN' | 'en-US';
  };
}

export interface ResolvedInspectorOptions {
  enabled: boolean;
  workspaceRoot?: string;
  sourceRoots: string[];
  include: Array<string | RegExp>;
  exclude: Array<string | RegExp>;
  bridge: boolean;
  remoteBrowser: boolean;
  debugLog: boolean;
  compiler?: VueCompilerAdapter;
  ui: {
    enabled: boolean;
    buttonPosition: ButtonPosition;
    shortcut: string | false;
    singleShot: boolean;
    language: 'zh-CN' | 'en-US';
  };
}

export function resolveInspectorOptions(options: WebSourceInspectorOptions = {}): ResolvedInspectorOptions {
  const uiOptions = typeof options.ui === 'object' ? options.ui : {};
  return {
    enabled: options.enabled ?? true,
    workspaceRoot: options.workspaceRoot,
    sourceRoots: options.sourceRoots || [],
    include: options.include || [],
    exclude: options.exclude || [],
    bridge: options.bridge ?? true,
    remoteBrowser: false,
    debugLog: options.debugLog ?? false,
    compiler: options.compiler,
    ui: {
      enabled: options.ui !== false,
      buttonPosition: uiOptions.buttonPosition || 'bottom-right',
      shortcut: uiOptions.shortcut === undefined ? 'Alt+Shift+C' : uiOptions.shortcut,
      singleShot: uiOptions.singleShot ?? true,
      language: uiOptions.language || 'zh-CN'
    }
  };
}

export interface ResolvedInspectorAssets {
  runtimeModuleSource?: string;
  runtimeModuleId: string;
}

export function resolveInspectorAssets(
  assets: WebSourceInspectorAssets = {},
): ResolvedInspectorAssets {
  const runtimeModuleId = assets.runtimeModuleId ?? '@web-source-inspector/runtime';
  if (
    typeof runtimeModuleId !== 'string' ||
    runtimeModuleId.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(runtimeModuleId)
  ) {
    throw new TypeError('runtimeModuleId 格式无效');
  }
  if (
    assets.runtimeModuleSource !== undefined &&
    (typeof assets.runtimeModuleSource !== 'string' || assets.runtimeModuleSource.length === 0)
  ) {
    throw new TypeError('runtimeModuleSource 必须是非空 ESM 字符串');
  }
  return {
    runtimeModuleId,
    runtimeModuleSource: assets.runtimeModuleSource,
  };
}
