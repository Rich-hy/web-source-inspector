# Web Source Inspector 最终使用文档

## 1. 这是什么

Web Source Inspector 是一个配合 VS Code 或 Cursor 使用的 Vue 源码定位工具。

在 Vue 项目的开发页面中开启 Inspector 后，点击浏览器里的元素，编辑器会打开对应的 `.vue` 文件，并定位到该元素所在的 `<template>` 标签。

它由两部分组成：

- `web-source-inspector`：安装在业务项目中的 npm 开发依赖，负责接入 Vite、Webpack 或 Vue CLI 的开发构建流程。
- `web-source-inspector-vscode`：安装到 VS Code/Cursor 的 VSIX 插件，负责接收定位请求并打开源码。

它不是一个单独长期运行的网站。你以前看到的 `http://127.0.0.1:41730/` 是仓库测试项目的开发页面；实际使用时，应该打开的是你自己的业务项目运行后的地址。

## 2. 当前交付文件

本地 npm 安装包：

```text
D:\otherProject\web-source-inspector\web-source-inspector-0.1.0-beta.2.tgz
```

VS Code/Cursor 插件安装包：

```text
D:\otherProject\web-source-inspector\packages\vscode-extension\web-source-inspector.vsix
```

当前为 `0.1.0-beta.2` 发布候选；npm 与各扩展市场的发布状态需要分别查询确认。本地验收可使用以上文件安装。

## 3. 使用前提

- 本机安装 VS Code `1.90+` 或兼容版本 Cursor。
- 业务项目是 Vue 项目，使用 Vue `2.6`、Vue `2.7` 或 Vue `3.2+`。
- 业务项目使用 Vite `2~6`，或 Webpack `4/5`、Vue CLI `3/4/5` 的标准配置。
- 项目开发服务、浏览器、Cursor/VS Code 和项目源码都在同一台电脑。
- 运行 npm 包的 Node.js 版本不低于 `16.20.2`。

## 4. 第一次安装

### 4.1 安装 VSIX 到 Cursor 或 VS Code

1. 打开 Cursor 或 VS Code。
2. 打开 Extensions 扩展视图。
3. 点击扩展视图右上角的更多操作菜单。
4. 选择 `Install from VSIX...`。
5. 选择文件：

```text
D:\otherProject\web-source-inspector\packages\vscode-extension\web-source-inspector.vsix
```

6. 按编辑器提示 Reload。

安装后，打开你的业务项目目录，并确认该 workspace 是受信任的本地项目。

### 4.2 在业务项目安装 npm 包

打开终端，进入你的实际 Vue 项目目录。例如：

```powershell
cd D:\your-project
npm install -D "D:\otherProject\web-source-inspector\web-source-inspector-0.1.0-beta.2.tgz"
```

使用 pnpm 或 yarn 时也可以安装同一个 `.tgz` 文件：

```powershell
pnpm add -D "D:\otherProject\web-source-inspector\web-source-inspector-0.1.0-beta.2.tgz"
```

安装 npm 包本身不会自动修改你的项目配置。

## 5. 启用项目

完成 npm 安装后，选择下面任意一个入口即可。两种方式使用同一套检测和安全写入逻辑，不需要两个都执行。

### 方式 A：在 Cursor / VS Code 中启用

1. 用 Cursor 或 VS Code 打开业务项目。
2. 按 `Ctrl+Shift+P` 打开命令面板。
3. 执行：

```text
Source Inspector: Enable Project
```

4. 查看扩展展示的配置修改预览。
5. 确认后应用。

扩展会读取当前项目的本地 `node_modules/web-source-inspector`，不会使用全局包，也不会下载依赖。

### 方式 B：在终端中启用

确保终端当前目录是业务项目根目录，然后执行：

```powershell
npx web-source-inspector init
```

CLI 会检测 Vue、Vite、Webpack 或 Vue CLI 配置，展示计划并要求确认。

启用后，工具只会把 Adapter 接入受支持的构建配置；不会修改你的组件、路由、`index.html` 或原有 npm scripts。对于无法安全识别的动态配置，它会拒绝自动修改并给出诊断，而不是猜测改写。

## 6. 日常使用

启用完成后，继续按项目原来的方式启动开发服务：

```powershell
npm run dev
```

或：

```powershell
npm run serve
```

然后打开业务项目实际输出的浏览器地址，例如 Vite 常见的 `http://localhost:5173/`。

页面右下角会出现 Inspector 按钮。使用方式：

1. 点击 Inspector 按钮，或按 `Alt+Shift+C`，进入选择模式。
2. 移动鼠标到目标元素上，确认高亮正常。
3. 点击目标元素。
4. 已连接的 Cursor 或 VS Code 会打开对应 `.vue` 文件并定位到 `<template>` 中的源码位置。

选择模式默认是一次性的：成功打开后自动退出。按 `Esc` 可取消选择模式。

定位偏好：

- 普通点击：优先定位实际 DOM 元素所在的 template 标签。
- `Shift + 点击`：优先定位项目内组件的调用位置。
- `Alt + 点击`：优先定位最近的 `v-if`、`v-for` 等控制流位置。

Inspector 选择模式会拦截本次点击，避免误触页面中的链接、按钮或业务事件；退出后业务交互恢复正常。

### 6.1 同机网卡 IP 访问（仅 Vite）

默认 `browserAccess` 为 `same-machine`，同一台电脑可直接通过本机网卡 IP 打开 Vite 页面。同时让 Vite `server.host` 允许网卡访问，例如 `0.0.0.0` 或精确本机 IP。服务启动时冻结本机接口地址和实际监听端口；非回环浏览器的 socket 地址与页面 Origin 的字面量 IP、协议和端口必须完全相等。需要只允许 `localhost`、`127.0.0.1` 或 IPv6 loopback 时，配置 `webSourceInspector({ browserAccess: 'loopback' })`。网卡、VPN 或虚拟接口变化后必须完整重启 Dev Server。Bridge 仍只监听 `127.0.0.1`。`remoteBrowser` 已弃用且只能为 `false`；代理、端口转发、WSL、Docker、Dev Container、Remote SSH、手机和其它电脑不支持。

## 7. 常用编辑器命令

| 命令 | 用途 |
| --- | --- |
| `Source Inspector: Enable Project` | 检测、预览并启用当前项目 |
| `Source Inspector: View Integration Plan` | 只预览配置修改，不写入文件 |
| `Source Inspector: Run Doctor` | 检查包安装、项目配置和运行状态 |
| `Source Inspector: Disable Project` | 安全移除工具创建的配置节点 |
| `Source Inspector: Connect Session` | 手动选择要连接的本地开发服务 |
| `Source Inspector: Toggle Browser Select Mode` | 从编辑器控制浏览器进入/退出选择模式 |
| `Source Inspector: Show Diagnostics` | 查看已脱敏的诊断日志 |
| `Source Inspector: Disconnect` | 断开当前开发服务会话 |

## 8. 命令行维护

在业务项目根目录执行：

```powershell
npx web-source-inspector doctor
```

用于检查 npm 包、项目接入配置和可恢复状态。

```powershell
npx web-source-inspector remove
```

用于撤销由 Source Inspector 创建且仍未被人工修改的配置节点。它不会删除它不拥有的配置。

## 9. 当前支持范围

首版目标是定位 Vue SFC 中普通 HTML `<template>` 的来源。

支持或已实现的能力包括：

- Vite，以及 Webpack/Vue CLI 标准配置接入。
- Vue 2.6、Vue 2.7、Vue 3.2+ 的代码路径。
- `.vue` 中使用 JavaScript、TypeScript、Options API、Composition API 或项目自身支持的 `script setup`；script 类型不会改变 template 定位语义。
- 普通元素、组件调用点、`v-for`、条件、Slot、Fragment、动态组件和 Teleport 的候选定位。
- 第三方组件默认回退到业务项目中的组件调用位置，不进入 `node_modules` 定位内部源码。

当前不支持：

- 纯 JavaScript DOM 定位。
- JSX、TSX、render 函数。
- React、Svelte、SSR/hydration。
- Pug、MDX、外部 `<template src>`。
- Three.js/Canvas 对象级源码定位。
- WSL、Remote SSH、Dev Container、Codespaces 和其它设备上的浏览器。

## 10. 已验证与待验证边界

当前已完成验证：

- Vue 3.5 + Vite 6：浏览器 Inspector E2E。
- Vue 3.5 + Webpack 5 + vue-loader 17 + WDS 4：Loader、Runtime、WDS 浏览器链路 E2E。
- TypeScript 类型检查、244 项单元/集成测试、完整 workspace 构建。
- Vue 2.7.16 + Vue CLI 3.12.1 + Webpack 4.47.0 + vue-loader 15.11.1：已在真实业务项目 `xuanwu-ui-2.0` 连续完成空缓存启动和不清缓存重启，两次 WSI Loader/metadata 错误均为 0，页面、运行时和 `ImgTurnPage.vue` 异步 chunk 均可正常获取。
- 同一真实项目已验证 Vue CLI 3 的 WDS hook 使用 `before(app, server)` 和 `server.compiler`；开发服务成功编译，WSI 消息端点已挂载，Session descriptor 已生成，Cursor 与本机 Bridge 已建立连接。
- 最终 npm tgz 在 Node.js `16.20.2` 下的 CJS、ESM、CLI 和物理 Webpack Loader 安装后 smoke。
- Vite basic 与 Webpack basic 生产构建：未注入 Inspector marker、Runtime、Bridge 特征或 workspace 绝对路径。
- `0.1.0-beta.2`：地址策略、Vite、Webpack 与初始化器的 8 个聚焦测试文件共 105 项通过；15 个 workspace 的类型检查、内部库构建、Webpack Adapter 构建、公开包构建和 npm tgz 打包均通过。tgz 已检查公开文件白名单、声明文件、默认 `same-machine` 与 Bridge loopback 监听。
- 历史 `0.1.0-beta.1`：仓库 Vite `6.4.3` 聚焦测试通过；消费项目 Vite `6.4.1` 的 `http://localhost:3002/`、`http://127.0.0.1:3002/` 与 `http://192.168.8.155:3002/` 都已验证 Runtime、marker、Cursor 回执和页面刷新，Bridge 仍只监听 `127.0.0.1`；消费项目生产产物扫描未命中 Inspector 特征。该版本的默认 loopback fixture 经本机网卡 IP 访问会拒绝连接。

当前仍需在真实项目中补齐的验证：

- 在 `xuanwu-ui-2.0` 页面中手动点击具体元素，验收 Cursor 打开实际 `.vue` 文件并定位到 template 标签的最终交互。
- Vue 2.6、vue-loader 16、Vue CLI 4/5，以及其它 Vue 2 + Webpack 组合的完整真实版本矩阵。
- Element Plus、monorepo、多浏览器 tab、多 IDE 和 HMR stale 的完整业务项目场景。
- 第二台真实设备或隔离 VM 的拒绝证据；当前只能声明本机网卡 IP 可用，不能声明远端设备已验证拒绝。

因此，建议第一次接入时优先用 Vue 3 + Vite 或 Vue 3 + Webpack 5 的常规项目验收；其它组合先运行 `Source Inspector: View Integration Plan` 和 `Source Inspector: Run Doctor`，确认检测结果后再启用。

## 11. 常见问题

### 页面没有 Inspector 按钮

确认以下事项：

1. 已在该业务项目安装 `web-source-inspector`。
2. 已执行 `npx web-source-inspector init` 或 `Source Inspector: Enable Project`。
3. 当前是开发服务，不是生产构建或 preview。
4. 已重启项目原来的 dev/serve 命令。

然后执行：

```powershell
npx web-source-inspector doctor
```

### 点击元素后没有打开 Cursor / VS Code

确认：

1. 已安装 VSIX，且编辑器已 Reload。
2. Cursor/VS Code 打开的就是该业务项目 workspace。
3. Workspace 已受信任，且不是 Remote SSH、WSL 或 Dev Container。
4. 开发服务、浏览器、编辑器和项目源码在同一台机器。
5. 从命令面板执行 `Source Inspector: Connect Session`，手动选择会话。

### 页面提示“IDE 未连接”

Cursor 进程已经打开，不代表项目开发服务已经建立 Source Inspector Bridge。请按顺序检查：

1. 安装最新的本地 npm tgz 后，重新执行一次 `npx web-source-inspector init`。
2. 修改或重新初始化配置后，必须完整重启项目的 `dev`/`serve` 进程。
3. Vue CLI 3 / Webpack Dev Server 3 的自动配置应使用 `before(app, server)`，并把 `server.compiler` 传给 middleware；不要手工依赖第三个 `compiler` 参数。
4. Cursor 打开的 workspace 必须与正在运行的项目根目录一致，并且 workspace 已受信任。
5. 执行 `Source Inspector: Connect Session`；如果仍未发现会话，再执行 `Developer: Reload Window`。

重新执行 `npx web-source-inspector init` 显示无修改计划，且重启后仍提示未连接时，再运行 `Source Inspector: Show Diagnostics` 查看扩展诊断。

### 我不想继续使用了

在业务项目根目录执行：

```powershell
npx web-source-inspector remove
```

然后可按需卸载 npm 包，并在 Cursor/VS Code 中卸载 VSIX 插件。

## 12. 文件校验值

本次本地候选产物的 SHA-256：

```text
web-source-inspector-0.1.0-beta.2.tgz
9581C9D7FA7F87BC87E8DAF91FAE21E2C46FBB56C4A43DD644FFA2FBD1270535

web-source-inspector.vsix
9B26D6A2A0DF094E0FE5BF6D377440A75E1FDB094165891C5E5A91BD5126E488
```
