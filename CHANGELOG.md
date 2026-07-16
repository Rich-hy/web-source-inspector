# Changelog

本文记录 Web Source Inspector 的用户可见变化。项目遵循 SemVer；npm 与各扩展市场的发布状态需要分别查询确认。

## 0.1.0-beta.4 - 2026-07-15

发布单元：npm `web-source-inspector@0.1.0-beta.4`；手动安装的 VSIX `web-source-inspector-vscode@0.1.1`。

### Changed

- Vite、Webpack 和 Vue CLI 接入统一执行严格的运行期 toolchain 判定；不完整或不兼容的 Vue、compiler、Vue plugin、`vue-loader`、Webpack 或 Dev Server 组合会给出明确诊断，而不是继续以不可靠方式运行。
- monorepo 中依赖提升到 workspace 根目录的 Vue/Vite/Webpack 项目，会以应用项目自身的 `package.json` 作为解析锚点，正确读取实际依赖事实。
- 初始化器和 Doctor 同步展示兼容性结论，Webpack 对缺少真实 `vue-loader` 事实的项目采取拒绝接入的保守策略。

### Security

- Webpack 源码候选和项目边界继续基于 realpath 校验，符号链接或 Junction 指向 workspace 外部时不会作为可打开源码返回。

## 0.1.0-beta.2 - 2026-07-14

### Changed

- Vite 的 `browserAccess` 默认值改为 `same-machine`。零参数 `webSourceInspector()` 在 Vite `server.host` 允许本机网卡访问时可直接用于同机 IP 页面；显式 `browserAccess: 'loopback'` 保留为更严格的收紧选项。
- VS Code/Cursor 初始化器的默认选择同步为允许本机网卡 IP，且可显式生成 `browserAccess: 'loopback'` 配置。

### Security

- 默认同机模式仍只接受 Dev Server 启动时冻结的本机地址，非回环 socket 与 Origin 的 IP、协议和实际端口必须精确匹配。IDE Bridge 继续只监听 `127.0.0.1`，不增加其它设备访问能力。

## 0.1.0-beta.1 - 2026-07-14

### Added

- Vite 新增 `browserAccess: 'loopback' | 'same-machine'`。默认仅允许回环浏览器；同机模式只接受启动时冻结的本机网卡地址，并要求 socket 地址与 Origin 字面量 IP、协议和实际端口精确匹配。
- 初始化器 CLI 与 VS Code/Cursor 入口新增 Vite 的本机网卡 IP 选择，并保留 AST 所有权、plan/apply 与 remove 恢复边界。

### Security

- IDE Bridge 继续只监听 `127.0.0.1`。`remoteBrowser` 已弃用且只允许 `false`；不支持其它设备、代理、端口转发、WSL、Docker、Dev Container 或 Remote SSH。
- 网卡地址在 Dev Server 启动时冻结；地址变化后必须完整重启服务。

## 0.1.0 - 2026-07-10

状态：首个开发实现基线。打包 VSIX 已在 Cursor 中安装并连接真实 Vue CLI 3 项目的本机 Bridge，但浏览器点击到实际文件打开的完整交互和 VS Code 安装矩阵尚未完成，因此仍不是公开稳定版本。

### Added

- 建立 `protocol`、`compiler-core`、`transform-vue`、`runtime`、`dev-session-core`、`vite-plugin`、`adapter-webpack`、`init-core`、公开 npm 包和 VS Code/Cursor Extension。
- 新增唯一公开包 `web-source-inspector`，提供 CLI、`/vite`、`/webpack`、browser runtime 和 webpack loader 物理资产。
- 新增 `npx web-source-inspector init/doctor/remove`，以及 Extension 的 Enable Project、View Integration Plan、Run Doctor、Disable Project 命令。
- Vue 2.6/2.7/3 的普通 HTML template 转换实现，以及 Vite、Webpack/Vue CLI 开发态接入。
- sourceId、SourceRecord、候选排序、内存 Manifest、HMR generation 和 stale tombstone。
- Browser Runtime 的 Shadow DOM 按钮、高亮、tooltip、快捷键、单次选择和业务事件隔离。
- bundler-neutral Browser Router、认证 loopback Bridge、session 发现、心跳、请求限流与多实例路由。
- Extension 的 Workspace Trust、remote 环境拒绝、realpath containment、未保存内容上下文校正和源码候选 Quick Pick。
- basic fixture 的 7 项 Playwright 用例，覆盖注入、Inspector pointer 隔离、`v-for`、Teleport、`inheritAttrs: false` Shift 调用点、业务点击拦截/恢复和 tooltip 路径脱敏。
- Extension Host 自动化入口、VSIX 打包脚本及发布检查文档。

### Fixed

- Vue 2.7 SFC 解析改用 `parseComponent`，避免完整 `.vue` 文件被误判为没有 template。
- 忽略 Vue 2.7 SFC 分块解析器对标准 HTML void 标签的假闭合错误，真实 template 语法仍由模板编译器校验。
- Vue 2.6/2.7 转换保留原始 template 缩进和 CRLF 坐标，并补回 compiler `trim` 的前导 offset，避免 marker 注入到前一个标签或注释中。
- 对齐 vue-loader 15 的 Vue 2 模板编译选项，兼容无范围插值文本、空白 template 和 `{ msg, start, end }` 编译错误对象。
- Webpack Loader 接受 vue-loader 15 的 deindent selector 输出，同时继续使用原始 template 生成源码记录和 source map。
- Vue CLI 3 / vue-loader 15 开发态只关闭 template 请求链中的 pitcher cache 与 `cache-loader/thread-loader`，避免缓存命中后丢失 WSI build metadata，同时保留普通 JavaScript 缓存。
- Vue CLI 3 / Webpack Dev Server 3 的 Browser middleware 改为使用 `before(app, server)` 提供的 `server.compiler`，并安全迁移旧初始化器生成的三参数 hook 及其 integration state 指纹。

### Security

- Browser 的业务定位数据只提交不透明 sourceId，同时携带 Browser Transport 专用认证和必要会话元数据；不接收或提交路径、行列、源码上下文、IDE Bridge token 或命令。
- Bridge 只监听 `127.0.0.1`，要求随机 token、随机 path 和固定 WebSocket subprotocol。
- IDE 对 wire path、session root、workspace root、realpath、symlink/Junction 和普通文件类型做二次校验。
- untrusted workspace、Remote SSH、WSL、Dev Container 和 Codespaces 默认不连接或打开源码。
- Vite build/preview 和 Webpack production/no-session 路径保持 no-op，并要求发布前执行实际产物字符串扫描。

### Known Limitations

- Three.js/Canvas 对象、React、SSR、Pug/MDX 和远程 Extension Host 尚不支持。
- Vue 2.7 + Webpack 4 + Vue CLI 3 已完成一个真实业务项目的编译、middleware、Session 和 Cursor Bridge 验证；其它 Vue 2、Webpack 4、Vue CLI 3/4/5 与完整 Vite 2～6 tuple 仍需独立证据。
- Element Plus 与 monorepo fixture 已存在，但尚未接入当前根 Playwright 流程。
- HMR stale、多 tab、多 IDE，以及浏览器点击后由 Bridge 在真实编辑器打开文件的完整端到端证据仍需补齐。
- Cursor 已完成真实 VSIX 安装和 Bridge 自动连接；VS Code 1.90、当前 VS Code 的安装 smoke，以及 Cursor 最终文件打开/reveal 仍需验证，不能据此声明市场兼容性。
- 当前不支持远程浏览器配对，`remoteBrowser` 始终保持关闭。

### Distribution Notes

- `0.1.0` 的唯一 npm tarball、VSIX、生产消费项目扫描和第三方 NOTICE 必须在公开发布候选上重新核验。
- 没有当次验证记录时，不能把仓库中的测试或脚本存在视为测试已经通过。
