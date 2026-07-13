# Web Source Inspector

> 简体中文 | [English](README.en.md)

Web Source Inspector 用于在 Vue 开发页面中选择一个元素，并在 VS Code 或 Cursor 中打开其对应的 <code>.vue</code> template 源码位置。它同时覆盖 Vite、Webpack 与 Vue CLI 的开发链路，让“页面上的元素来自哪里”不再需要靠手工搜索判断。

定位由项目端 Adapter、浏览器 Runtime、本机 Loopback Bridge 和 IDE 扩展协同完成。浏览器只提交不透明的 <code>sourceId</code>、认证 token 与必要会话元数据；不会上传本机文件路径、源码范围或 IDE Bridge 凭据。

> **版本状态：** 当前为 <code>0.1.0</code> 开发候选，尚未发布到 npm、VS Marketplace、Open VSX 或 Cursor Marketplace。npm 包与 VSIX 均需从本仓库本地打包；真实 VS Code/Cursor 安装验证仍应在发布前单独留存证据。

## 核心能力

- 普通 DOM、组件调用、<code>v-for</code>、条件分支、Slot、Fragment、动态组件和 Teleport 的源码 marker。
- Shadow DOM Inspector：支持 hover 高亮、无路径 tooltip、<code>Alt+Shift+C</code> 快捷键与业务事件隔离。
- 通过 CLI 或 VS Code/Cursor 扩展检测并接入 Vite、Webpack、Vue CLI 配置；接入前会展示计划，无法安全识别的动态配置不会猜测改写。
- 支持 HMR generation、旧 <code>sourceId</code> tombstone、内存 Manifest，以及多浏览器 Tab / 多 IDE 的会话路由。
- 使用仅监听 loopback 的认证 Bridge、Workspace Trust、realpath 路径校验和未保存内容附近校正，限制来源定位只在可信本机 workspace 内执行。

## 支持范围与限制

- 实现范围为 Vue 2.6、Vue 2.7、Vue 3.2+，以及 Vite 2～6、Webpack 4/5、Vue CLI 3/4/5 的标准配置形态；每个版本组合的实际验证状态以 [能力矩阵](docs/capabilities.md) 为准。
- 第三方组件内部模板默认不转换，会降级定位到用户项目中的组件调用点。
- 当前不承诺 Three.js/Canvas 对象、React、SSR、Pug/MDX、WSL、Remote SSH、Dev Container 或 Codespaces；远程浏览器也不在支持范围内。

### 当前验证基线

下表仅说明已留存的自动化或本机证据，不代表所有版本组合均已完成端到端发布验证：

| 环境 | 当前证据 |
| --- | --- |
| Vue 3.5.39 + Vite 6.4.3 + @vitejs/plugin-vue 5.2.4 | 7 项浏览器 E2E 覆盖 Inspector UI、marker、事件隔离、<code>v-for</code>、Teleport、组件调用点与 tooltip/协议隐私。 |
| Vue 3.5.39 + Webpack 5.108.4 + vue-loader 17.4.2 + WDS 4.15.2 | 1 项浏览器 E2E 覆盖 Loader、Runtime、WDS stream/hello 与 metadata 请求。 |
| Vue 2.7.16 + Vue CLI 3.12.1 + Webpack 4.47.0 + vue-loader 15.11.1 | 已完成本机启动/重启与 Cursor VSIX 安装、Bridge 连接；浏览器点击到实际文件打开仍待验证。 |

完整的实现、自动化、真实 VSIX 与发布验证边界见 [能力矩阵](docs/capabilities.md)。

## 快速开始：接入业务项目

业务项目需要 Node.js <code>>=16.20.2</code>、受支持的 Vue 与构建工具组合，以及 VS Code <code>>=1.90</code> 或兼容的 Cursor。浏览器、开发服务器、IDE Extension Host 与源码 workspace 必须位于同一台本机；仓库开发环境要求见 [本地开发](#本地开发)。

先在 Vue 项目中安装唯一公开 npm 包：

```powershell
npm install -D web-source-inspector
```

当前仓库还未发布到 npm registry。本地验收时先在本仓库执行 `pnpm package:npm`，再把生成的 `.tgz` 作为 devDependency 安装到目标项目；正式发布后才使用上面的 registry 安装命令。

然后选择任一入口完成一次项目接入：

```powershell
npx web-source-inspector init
```

或安装本仓库生成的 VSIX，在 VS Code/Cursor 中执行 **Source Inspector: Enable Project**。两个入口调用同一套检测、预览和安全写入逻辑；它们只修改受支持的 Vite、Webpack 或 Vue CLI 配置，不替换原有启动命令。

接入后继续执行项目原来的 `npm run dev`、`npm run serve` 或等价命令。开发页面出现 Inspector 按钮后，点击按钮或按 `Alt+Shift+C` 进入选择模式，再点击目标元素；已连接的 VS Code/Cursor 会打开对应 `.vue` 文件并定位 template 范围。

检查或撤销接入：

```powershell
npx web-source-inspector doctor
npx web-source-inspector remove
```

## 完成一次定位

1. 在 VS Code 或 Cursor 中以受信任的本地 workspace 打开已接入的 Vue 项目。
2. 继续运行项目原有的开发命令，例如 <code>npm run dev</code> 或 <code>npm run serve</code>。
3. 让扩展自动连接唯一匹配的本地 session，或手动选择 session 与浏览器 Tab。
4. 点击页面中的 Inspector 按钮，或按 <code>Alt+Shift+C</code> 进入选择模式；hover 目标元素确认高亮和提示。
5. 点击目标元素，扩展会复核可信相对路径、workspace root 与 realpath，再打开对应的 <code>.vue</code> template 范围。

按 <code>Esc</code> 可退出选择模式。默认成功定位后会退出；<code>Shift+点击</code> 优先选择组件调用点，<code>Alt+点击</code> 优先选择附近的控制流候选。

## 工作原理

```text
Vue SFC
  -> Vite 或 Webpack/Vue CLI Adapter 注入 DOM/组件双 marker
  -> Browser Runtime 选择 sourceId
  -> Dev Server 内存 Manifest 解析可信相对路径和范围
  -> 127.0.0.1 随机端口 Bridge
  -> VS Code/Cursor 扩展复核 workspace 后打开源码
```

## 本地开发

本仓库开发环境要求 Node.js <code>>=20.19.0</code>、pnpm <code>>=10</code>、VS Code <code>>=1.90</code> 或兼容版本的 Cursor。业务项目的 Node.js 要求较低，详见 [快速开始](#快速开始接入业务项目)。

```powershell
pnpm install
pnpm build
pnpm dev:basic
```

浏览器访问 Vite 输出的本机地址。右下角出现源码检查器按钮后，可以先验证 marker、hover 和业务事件拦截；要实际打开源码，还需要安装并连接本地 VSIX。

```powershell
pnpm package:vsix
```

产物位于 `packages/vscode-extension/web-source-inspector.vsix`。在 VS Code 或 Cursor 的 Extensions 视图中使用 **Install from VSIX...** 安装，然后打开本仓库 workspace。

完整接入步骤见 [快速开始](docs/quick-start.md)。

## Workspace 包

| 包 | 职责 |
| --- | --- |
| `@web-source-inspector/protocol` | 版本、消息类型、限制、错误码和运行时校验 |
| `@web-source-inspector/compiler-core` | sourceId、SourceRecord、Manifest、摘要和候选排序 |
| `@web-source-inspector/transform-vue` | Vue SFC AST 转换、marker 注入和 sourcemap |
| `@web-source-inspector/runtime` | 浏览器按钮、高亮、选择模式和 HMR transport |
| `@web-source-inspector/dev-session-core` | bundler-neutral Browser Router、Bridge 与 session 生命周期 |
| `@web-source-inspector/vite-plugin` | Vite Adapter、Runtime 注入与 Manifest 生命周期 |
| `@web-source-inspector/adapter-webpack` | Webpack/Vue CLI Plugin、Loader 与浏览器 transport |
| `@web-source-inspector/init-core` | 项目检测、AST plan/apply/remove、doctor 与事务恢复 |
| `web-source-inspector` | 唯一公开 npm 包、CLI 及 Vite/Webpack 导出 |
| `web-source-inspector-vscode` | VS Code/Cursor 扩展、项目启用、会话发现和源码打开 |

`fixtures/` 包含基础 Vue、Webpack、Element Plus 和 monorepo 接入工程。当前 Playwright 自动化包含 Vite basic fixture 的 7 项浏览器用例，以及 Webpack basic fixture 的 1 项 Loader、Runtime、WDS 全链路用例；Element Plus 和 monorepo fixture 尚未形成自动化 E2E 证据。

## 开发与质量检查

```powershell
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm package:npm
pnpm package:vsix
```

Playwright 首次运行前，如本机没有 Chromium，需要执行 <code>pnpm exec playwright install chromium</code>。自动化检查、npm tarball smoke、打包 VSIX 安装与真实浏览器到编辑器定位属于不同证据层级；发布前请以 [能力矩阵](docs/capabilities.md) 与 [发布清单](docs/release.md) 为准。

## 延伸阅读

- [快速开始与配置](docs/quick-start.md)
- [架构与关键决策](docs/architecture.md)
- [协议](docs/protocol.md)
- [安全模型](docs/security.md)
- [能力与验证矩阵](docs/capabilities.md)
- [Adapter 编写约束](docs/adapter-authoring.md)
- [故障排查](docs/troubleshooting.md)
- [发布与 VSIX](docs/release.md)
- [变更记录](CHANGELOG.md)
- [安全问题报告](SECURITY.md)
- [第三方许可证](THIRD_PARTY_NOTICES.md)

## 安全与生产边界

Vite Adapter 仅在真实开发服务中创建 session；Webpack Adapter 只在 `mode: 'development'` 且存在可用开发传输时启用。生产构建不应注入 Runtime、`data-wsi-source`、`data-wsi-component-source`、浏览器事件、Manifest 或 Bridge。发布消费项目之前仍需按 [安全文档](docs/security.md#生产构建核验) 对实际产物执行字符串检查。

浏览器协议不携带本机路径或源码范围；IDE 扩展会在打开文件前再次校验 workspace root、相对路径与 realpath containment。Bridge 只监听 loopback，且受认证与会话路由保护；workspace 外文件始终拒绝打开。安全问题请按 [SECURITY.md](SECURITY.md) 中的流程私下报告。

## License

[MIT](LICENSE)。第三方依赖与分发评估见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
