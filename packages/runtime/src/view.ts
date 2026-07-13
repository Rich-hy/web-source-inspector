import type {
  BrowserMetadataPayload,
  ButtonPosition,
  ConnectionState,
  InspectorMode,
  SourceCandidate
} from './types';

const positionStyles: Record<ButtonPosition, string> = {
  'top-left': 'top:16px;left:16px',
  'top-right': 'top:16px;right:16px',
  'bottom-left': 'bottom:16px;left:16px',
  'bottom-right': 'bottom:16px;right:16px'
};

const styles = `
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; letter-spacing: 0; }
  .wsi-layer { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #171a1f; }
  .wsi-button { position: fixed; width: 42px; height: 42px; padding: 0; border: 1px solid #c7ccd3; border-radius: 6px; background: #ffffff; color: #20242a; box-shadow: 0 4px 16px rgba(24, 30, 38, .18); pointer-events: auto; cursor: pointer; }
  .wsi-button:hover { border-color: #2f7d5b; background: #f4faf7; }
  .wsi-button:focus-visible { outline: 2px solid #1769aa; outline-offset: 2px; }
  .wsi-button[data-mode="armed"], .wsi-button[data-mode="opening"] { background: #163f32; color: #ffffff; border-color: #163f32; }
  .wsi-crosshair { position: absolute; width: 18px; height: 18px; inset: 11px; border: 2px solid currentColor; border-radius: 50%; }
  .wsi-crosshair::before, .wsi-crosshair::after { content: ""; position: absolute; background: currentColor; }
  .wsi-crosshair::before { width: 24px; height: 2px; left: -5px; top: 6px; }
  .wsi-crosshair::after { width: 2px; height: 24px; left: 6px; top: -5px; }
  .wsi-status { position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px; border: 1px solid #ffffff; border-radius: 50%; background: #747b85; }
  .wsi-status[data-connection="connected"] { background: #28a36a; }
  .wsi-status[data-connection="stale"] { background: #d79018; }
  .wsi-status[data-connection="error"] { background: #c73b3b; }
  .wsi-outline { display: none; position: fixed; border: 2px solid #16885e; background: rgba(22, 136, 94, .08); pointer-events: none; }
  .wsi-outline[data-visible="true"] { display: block; }
  .wsi-tooltip { display: none; position: fixed; max-width: min(420px, calc(100vw - 16px)); padding: 7px 9px; border: 1px solid #2d333b; border-radius: 4px; background: #1f242b; color: #ffffff; box-shadow: 0 3px 12px rgba(0, 0, 0, .2); overflow-wrap: anywhere; pointer-events: none; }
  .wsi-tooltip[data-visible="true"] { display: block; }
  .wsi-title { font-weight: 650; }
  .wsi-detail { color: #d8dde5; margin-top: 2px; }
  .wsi-message { display: none; position: fixed; right: 16px; bottom: 68px; max-width: min(360px, calc(100vw - 32px)); padding: 8px 10px; border: 1px solid #c7ccd3; border-radius: 4px; background: #ffffff; color: #20242a; box-shadow: 0 4px 16px rgba(24, 30, 38, .16); }
  .wsi-message[data-visible="true"] { display: block; }
`;

export interface InspectorView {
  readonly host: HTMLDivElement;
  onToggle(listener: () => void): void;
  setMode(mode: InspectorMode): void;
  setConnection(state: ConnectionState, ideName?: string): void;
  showCandidate(candidate: SourceCandidate): void;
  showMetadata(metadata: BrowserMetadataPayload | null): void;
  clearCandidate(): void;
  showMessage(message: string, durationMs?: number): void;
  dispose(): void;
}

export function createInspectorView(position: ButtonPosition, language: 'zh-CN' | 'en-US'): InspectorView {
  const host = document.createElement('div');
  host.dataset.wsiRuntimeRoot = 'true';
  host.setAttribute('aria-hidden', 'false');

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = styles;

  const layer = document.createElement('div');
  layer.className = 'wsi-layer';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wsi-button';
  button.style.cssText = positionStyles[position];
  button.title = language === 'zh-CN' ? '源码检查器' : 'Source Inspector';
  button.setAttribute('aria-label', button.title);
  button.dataset.mode = 'disabled';
  button.innerHTML = '<span class="wsi-crosshair" aria-hidden="true"></span><span class="wsi-status" data-connection="disconnected" aria-hidden="true"></span>';

  const outline = document.createElement('div');
  outline.className = 'wsi-outline';
  outline.dataset.visible = 'false';

  const tooltip = document.createElement('div');
  tooltip.className = 'wsi-tooltip';
  tooltip.dataset.visible = 'false';
  tooltip.innerHTML = '<div class="wsi-title"></div><div class="wsi-detail"></div>';

  const message = document.createElement('div');
  message.className = 'wsi-message';
  message.dataset.visible = 'false';
  message.setAttribute('role', 'status');

  layer.append(outline, tooltip, message, button);
  shadow.append(style, layer);
  document.documentElement.append(host);

  const status = button.querySelector<HTMLElement>('.wsi-status');
  const title = tooltip.querySelector<HTMLElement>('.wsi-title');
  const detail = tooltip.querySelector<HTMLElement>('.wsi-detail');
  let currentCandidate: SourceCandidate | null = null;
  let currentMetadata: BrowserMetadataPayload | null = null;
  let currentMode: InspectorMode = 'disabled';
  let currentConnection: ConnectionState = 'disconnected';
  let messageTimer: ReturnType<typeof setTimeout> | undefined;

  function placeTooltip(rect: DOMRect): void {
    const margin = 8;
    const preferredTop = rect.bottom + margin;
    const tooltipHeight = tooltip.offsetHeight || 48;
    const top = preferredTop + tooltipHeight <= window.innerHeight
      ? preferredTop
      : Math.max(margin, rect.top - tooltipHeight - margin);
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - tooltip.offsetWidth - margin));
    tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function renderTooltip(): void {
    if (!currentCandidate || !title || !detail) {
      tooltip.dataset.visible = 'false';
      return;
    }
    const metadata = currentMetadata?.sourceId === currentCandidate.sourceId ? currentMetadata : null;
    const elementName = metadata?.tagName || currentCandidate.element.tagName.toLowerCase();
    const componentName = metadata?.componentName
      || (currentCandidate.kind === 'component'
        ? (language === 'zh-CN' ? '组件' : 'Component')
        : '');
    title.textContent = componentName
      ? `<${elementName}> · ${componentName}`
      : `<${elementName}>`;

    const connectionLabels: Record<ConnectionState, [string, string]> = {
      connected: ['点击定位', 'Click to open'],
      disconnected: ['IDE 未连接', 'IDE disconnected'],
      stale: ['页面源码已更新', 'Page source changed'],
      error: ['连接异常', 'Connection error']
    };
    const statusText = currentMode === 'opening'
      ? (language === 'zh-CN' ? '正在打开' : 'Opening')
      : connectionLabels[currentConnection][language === 'zh-CN' ? 0 : 1];
    detail.textContent = statusText;
    detail.hidden = false;
    tooltip.dataset.visible = 'true';
    placeTooltip(currentCandidate.element.getBoundingClientRect());
  }

  return {
    host,
    onToggle(listener) {
      button.addEventListener('click', listener);
    },
    setMode(mode) {
      currentMode = mode;
      button.dataset.mode = mode;
      button.setAttribute('aria-pressed', String(mode !== 'disabled'));
      renderTooltip();
    },
    setConnection(state, ideName) {
      currentConnection = state;
      if (status) {
        status.dataset.connection = state;
      }
      const connectionText = state === 'connected'
        ? (language === 'zh-CN' ? `已连接 ${ideName || 'IDE'}` : `Connected to ${ideName || 'IDE'}`)
        : (language === 'zh-CN' ? 'IDE 未连接' : 'IDE disconnected');
      button.title = `${language === 'zh-CN' ? '源码检查器' : 'Source Inspector'} · ${connectionText}`;
      renderTooltip();
    },
    showCandidate(candidate) {
      currentCandidate = candidate;
      currentMetadata = null;
      const rect = candidate.element.getBoundingClientRect();
      outline.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
      outline.style.width = `${Math.max(0, Math.round(rect.width))}px`;
      outline.style.height = `${Math.max(0, Math.round(rect.height))}px`;
      outline.dataset.visible = 'true';
      renderTooltip();
    },
    showMetadata(metadata) {
      currentMetadata = metadata;
      renderTooltip();
    },
    clearCandidate() {
      currentCandidate = null;
      currentMetadata = null;
      outline.dataset.visible = 'false';
      tooltip.dataset.visible = 'false';
    },
    showMessage(text, durationMs = 2600) {
      if (messageTimer) {
        clearTimeout(messageTimer);
      }
      message.textContent = text;
      message.dataset.visible = 'true';
      messageTimer = setTimeout(() => {
        message.dataset.visible = 'false';
      }, durationMs);
    },
    dispose() {
      if (messageTimer) {
        clearTimeout(messageTimer);
      }
      host.remove();
    }
  };
}
