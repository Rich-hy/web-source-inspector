# 快速开始

本文说明如何在 Vue 项目中启用 Web Source Inspector，以及如何在本仓库验证 Vite/Webpack Adapter。

## 前置条件

- 消费项目运行 `web-source-inspector`：Node.js `>=16.20.2`
- 本仓库开发：Node.js `>=20.19.0`、pnpm `>=10.0.0`
- Vue 2.6、Vue 2.7 或 Vue 3.2+
- Vite 2～6，或 Webpack 4/5、Vue CLI 3/4/5 的受支持标准配置
- VS Code `>=1.90` 或兼容版本 Cursor
- Dev Server、IDE Extension Host 和源码位于同一台本机

这些是实现范围，不代表每个版本组合都已经在当前机器完成真实 E2E。已验证组合和缺口见 [能力矩阵](capabilities.md)。

## 验证仓库内 fixture

```powershell
cd D:\otherProject\web-source-inspector
pnpm install
pnpm build
pnpm dev:basic
```

打开 Vite 输出的本机 URL。页面右下角应出现源码检查器按钮，按钮可通过以下方式开启选择模式：

- 点击按钮。
- 按 `Alt+Shift+C`。

选择模式中 hover 会显示高亮和 tooltip；`Esc` 退出。选择模式会在 capture 阶段阻止页面的 pointer、click 和 contextmenu 业务行为。

## 接入业务项目

安装唯一公开包：

```powershell
npm install -D web-source-inspector
```

当前 `0.1.0` 仍是本地发布候选。registry 未发布前，在仓库根执行 `pnpm package:npm`，再安装生成的 `.tgz`；扩展不会替项目下载或全局安装 npm 包。

`npm install` 本身不会静默修改项目配置。安装后必须选择一个一次性启用入口，两者使用同一套检测和 AST 修改逻辑。

### 入口一：命令行

```powershell
npx web-source-inspector init
```

CLI 会检测 Vue、构建工具、配置文件和开发服务器形态，展示修改计划并在确认后写入。无法安全识别的动态配置会返回诊断，不会猜测改写。

常用维护命令：

```powershell
npx web-source-inspector doctor
npx web-source-inspector remove
```

### 入口二：VS Code/Cursor 扩展

安装 VSIX 后打开受信任的本地项目，执行 **Source Inspector: Enable Project**。扩展只调用当前 workspace 内安装的 `web-source-inspector` CLI，先展示 diff 和 plan digest，再由用户确认应用。

也可执行：

- **Source Inspector: View Integration Plan**：只预览，不写文件。
- **Source Inspector: Run Doctor**：检查安装、配置和运行状态。
- **Source Inspector: Disable Project**：按所有权记录撤销 Inspector 创建的配置。

Monorepo 中会选择实际包含 Vue 应用和本地依赖的项目目录；无法唯一判断时由用户选择。

### 启用后的行为

继续执行项目原有开发命令，例如 `npm run dev` 或 `npm run serve`。初始化器只接入 Adapter，不修改 `index.html`、`main.ts`、路由、组件或原有 npm scripts。

Vite 配置会引用 `web-source-inspector/vite`；Webpack/Vue CLI 配置会引用 `web-source-inspector/webpack`。通常不需要手工写这些配置；高级选项只在受支持配置需要显式范围时使用。

## Vite 高级配置

自动初始化会生成默认 `webSourceInspector()`。需要限制 workspace 或调整浏览器 UI 时，可从公开子路径导入并配置：

```ts
import { webSourceInspector } from 'web-source-inspector/vite';
```

| 配置 | 默认值 | 当前语义 |
| --- | --- | --- |
| `enabled` | `true` | 是否执行 SFC 转换；只有真实 Vite dev server 会创建 session |
| `workspaceRoot` | 自动发现 | Manifest 和 IDE rootKey 的规范根 |
| `sourceRoots` | `[]` | 为空时允许 workspace 内源码；非空时限制到指定真实目录 |
| `include` | `[]` | 额外包含过滤；字符串按规范化路径包含匹配 |
| `exclude` | `[]` | 排除过滤；始终排除 `node_modules`、`dist`、`.git` |
| `bridge` | `true` | 是否启动本机 IDE Bridge |
| `browserAccess` | `same-machine` | 默认允许同一台电脑启动时快照中的本机网卡 IP；显式 `loopback` 可收紧为只允许回环地址 |
| `remoteBrowser` | `false` | 已弃用；只允许 `false`，不提供远程浏览器配对能力 |
| `debugLog` | `false` | 输出脱敏诊断码 |
| `ui` | `true` | `false` 时不注入浏览器入口；对象形式配置 Runtime |

`ui` 对象支持：

```ts
webSourceInspector({
  ui: {
    buttonPosition: 'bottom-right',
    shortcut: 'Alt+Shift+C', // 设为 false 可禁用
    singleShot: true,
    language: 'zh-CN',
  },
});
```

`buttonPosition` 可选 `top-left`、`top-right`、`bottom-left`、`bottom-right`；`language` 可选 `zh-CN`、`en-US`。

默认的 `webSourceInspector()` 已允许同一台电脑通过本机网卡 IP 访问 Vite 页面；`server.host` 仍须允许该接口，例如 `0.0.0.0`。服务使用实际监听端口，非回环 socket 的 Origin 必须是相同的字面量 IP；需要仅允许回环地址时，使用 `webSourceInspector({ browserAccess: 'loopback' })`。网卡变化后完整重启 Dev Server。Bridge 仍只监听 `127.0.0.1`，不支持其它设备、代理、转发、WSL、Docker 或 Remote SSH。

## 安装 VSIX

先构建并打包扩展：

```powershell
pnpm package:vsix
```

VSIX 输出：

```text
packages/vscode-extension/web-source-inspector.vsix
```

在 VS Code 或 Cursor 中：

1. 打开 Extensions 视图。
2. 从视图菜单选择 **Install from VSIX...**。
3. 选择上述文件并按编辑器提示 reload。
4. 打开运行 Vite、Webpack 或 Vue CLI 项目的同一个本地 workspace。
5. 确认 workspace 已受信任。

也可以用编辑器 CLI 安装 VSIX；源码打开主链路仍使用 Extension API：

```powershell
code --install-extension packages/vscode-extension/web-source-inspector.vsix
cursor --install-extension packages/vscode-extension/web-source-inspector.vsix
```

Cursor CLI 名称和位置取决于本机安装方式；不可用时使用图形界面安装。

以上是安装步骤，不是兼容性证明。当前尚未完成 VS Code 1.90、当前 VS Code 和 Cursor 的真实 VSIX smoke，发布状态以 [能力矩阵](capabilities.md) 和 [发布清单](release.md) 为准。

## 完成一次定位

1. 用 VS Code/Cursor 打开项目 workspace。
2. 启动已经启用 Adapter 的原项目开发服务器。
3. 扩展发现唯一匹配 session 后默认自动连接并 claim。
4. 在浏览器点击源码检查器按钮。
5. hover 目标，确认高亮和标签提示正常，且 tooltip 不出现路径或行列。
6. 点击目标，扩展会再次校验 rootKey、相对路径和 realpath，再打开源码范围。

默认 `singleShot: true`，成功打开后退出选择模式。普通点击选择最深 DOM 声明；`Shift+点击` 偏向组件候选；`Alt+点击` 偏向最近控制流候选。

## 扩展命令

| 命令 | 用途 |
| --- | --- |
| `Source Inspector: Enable Project` | 检测、预览并确认写入 Vite/Webpack/Vue CLI 接入配置 |
| `Source Inspector: View Integration Plan` | 只查看当前项目接入计划，不写文件 |
| `Source Inspector: Run Doctor` | 检查本地包、配置、状态和可恢复问题 |
| `Source Inspector: Disable Project` | 安全移除由 Inspector 管理的接入节点 |
| `Source Inspector: Connect Session` | 手动选择匹配的本地开发 session |
| `Source Inspector: Choose Session/Tab` | 选择 session 或 browser tab |
| `Source Inspector: Toggle Browser Select Mode` | 从 IDE 开关指定 tab 的选择模式 |
| `Source Inspector: Open Last Selection` | 重新打开上一次可信位置 |
| `Source Inspector: Choose Source Candidate` | 对上一次可信选择展示元素、组件调用点和控制流 Quick Pick，并打开所选候选 |
| `Source Inspector: Show Diagnostics` | 打开脱敏诊断输出 |
| `Source Inspector: Disconnect` | 释放 claim 并断开当前 session |

## 扩展设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `sourceInspector.autoConnect` | `true` | 只有一个匹配 session 时自动连接 |
| `sourceInspector.autoClaimFocusedWindow` | `true` | 聚焦窗口自动 claim |
| `sourceInspector.openMode` | `permanent` | `permanent` 或 `preview` |
| `sourceInspector.revealPosition` | `centerIfOutside` | `center`、`centerIfOutside` 或 `top` |
| `sourceInspector.enableContextRelocation` | `true` | 未保存内容导致摘要变化时尝试唯一上下文校正 |
| `sourceInspector.debugLog` | `false` | 输出脱敏诊断码 |

扩展当前不提供 `allowOutsideWorkspace`；workspace 外文件始终拒绝。

## 浏览器集成测试

首次在本机运行 Playwright 时安装 Chromium。只运行 Browser suite 时使用：

```powershell
pnpm exec playwright install chromium
pnpm test:e2e:browser
pnpm test:e2e:webpack
```

Vite basic fixture 定义 7 项用例：Runtime 按钮和 marker、Inspector pointer 隔离、`v-for` 同 ID、Teleport、Shift + `inheritAttrs: false` 调用点、业务 click 拦截/退出恢复，以及 tooltip 不泄漏路径/行列。Webpack basic fixture 另有 1 项真实链路用例，覆盖 43 字符 marker、业务点击、Inspector UI、WDS stream/hello 和 metadata request。

Element Plus 与 monorepo fixture 尚未接入根 Playwright 配置。IDE 真实打开仍需单独的 VS Code/Cursor VSIX smoke；详见 [能力矩阵](capabilities.md)。
