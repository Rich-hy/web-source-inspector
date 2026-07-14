# 发布与 VSIX

本文定义 `0.x` 阶段的发布门槛。命令均在仓库根执行，不包含 Git 操作。

## 发布单元

| 单元 | 产物 |
| --- | --- |
| `web-source-inspector` | 唯一公开 npm tarball，包含 CLI、Vite/Webpack 导出和物理 runtime/loader 资产 |
| `web-source-inspector-vscode` | VS Code/Cursor 共用 VSIX，文件名为 `web-source-inspector.vsix` |

`@web-source-inspector/*` workspace 包均为内部私有实现，不单独发布。未来 Three.js、React 或其它框架 adapter 是否拆包，需要在公共 API 稳定后单独评审。

当前 npm 发布候选为 `0.1.0-beta.2`；npm 与各 extension marketplace 的发布状态需要分别查询确认。

当前已生成本地 npm tgz 和 VSIX；tgz 的 24 项归档白名单、exports、Node.js 16.20.2 安装后根/Vite/Webpack CJS/ESM、物理 Loader 与 CLI doctor smoke，以及 VSIX 的 7 项归档白名单和 bundle freshness 已验证。当前类型检查覆盖 15 个 workspace 项目，单元/集成测试为 `239/239`；Browser E2E 包含 Vite 7 项和 Webpack 1 项，Extension Host trusted/untrusted 场景通过。Vite basic 与 Webpack basic 的生产构建及 Inspector/绝对路径扫描通过。VS Code 1.90、当前 VS Code 和 Cursor 的真实 VSIX 安装 smoke，以及 Element Plus、monorepo 和 Browser -> Bridge -> IDE 完整链路仍未形成发布证据。

## 版本规则

- 所有包遵循 SemVer。
- protocol major 变化需要 Runtime、Vite/Webpack Adapter、公开包和 Extension 协调发布。
- 同 major 的新增能力通过 capabilities 协商，不以包版本猜测功能。
- session 文件使用独立 `schemaVersion`；不兼容 schema 必须明确拒绝或提供受测迁移读取。
- server 与 extension 可以版本不同，但必须通过协议和 capability 验证。
- Vue/Vite/Webpack/Vue CLI 支持范围只能依据 fixture 矩阵发布。
- 配置弃用至少保留一个 minor 周期，并给出替代项和删除版本。

## 0.1.0-beta.2 默认同机网卡 IP 验收

`browserAccess` 默认 `same-machine`，Vite 在 `server.host` 允许本机网卡访问时无需额外插件配置。显式 `browserAccess: 'loopback'` 保留为只允许回环浏览器的收紧选项。发布记录必须分别保留：实际 listener 端口与冻结 `devOrigins`、Bridge 仍监听 `127.0.0.1`、localhost/127.0.0.1/本机网卡 IP 的开发态证据，以及生产构建无 Runtime/Bridge 特征的扫描结果。没有第二设备或隔离 VM 的拒绝证据时，只能声明本机网卡 IP 可用，不能声明远端设备已验证拒绝。代理、端口转发、WSL、Docker、Dev Container 和 Remote SSH 不支持。

本次 `0.1.0-beta.2` 必须重新保留聚焦测试、类型检查、构建和 tgz 检查证据；其中其它设备或隔离 VM 的拒绝证据仍未取得。

## 0.1.0-beta.1 同机网卡 IP 验收（历史）

`browserAccess` 默认 `loopback`，Vite 的 `same-machine` 只用于同一台电脑的本机网卡地址。发布记录必须分别保留：实际 listener 端口与冻结 `devOrigins`、Bridge 仍监听 `127.0.0.1`、localhost/127.0.0.1/本机网卡 IP 的开发态证据，以及生产构建无 Runtime/Bridge 特征的扫描结果。没有第二设备或隔离 VM 的拒绝证据时，只能声明本机网卡 IP 可用，不能声明远端设备已验证拒绝。代理、端口转发、WSL、Docker、Dev Container 和 Remote SSH 不支持。

本次 `0.1.0-beta.1` 证据：Vite `6.4.3` 聚焦测试和默认 loopback fixture 的本机网卡 IP 拒绝、消费项目 Vite `6.4.1` 的 localhost/127.0.0.1/`192.168.8.155` Runtime 与 Cursor 回执、Bridge loopback 检查、生产构建扫描均已执行。未取得第二设备或隔离 VM 的拒绝证据。

## 发布前阻断项

以下任一项未满足时不应发布稳定版本：

- typecheck、单元测试、浏览器 E2E、构建或 VSIX 打包失败。
- VS Code 或 Cursor 任一真实安装 smoke 未执行。
- 选择模式退出后仍拦截业务事件。
- 一次选择可广播打开多个 IDE。
- 路径安全用例能打开 workspace 外文件。
- 日志、tooltip、错误响应或 VSIX 包含 token/私有绝对路径。
- 消费项目生产构建包含 Runtime、marker 或 Bridge。
- 协议实现与 `@web-source-inspector/protocol` 定义漂移。
- 缺少 CHANGELOG、SECURITY 联系方式或必要 NOTICE 评估。

## 验证顺序

先确认依赖和浏览器运行环境已准备：

```powershell
pnpm install
pnpm exec playwright install chromium
```

按由窄到宽顺序执行：

```powershell
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm package:npm
pnpm package:vsix
```

每个命令需要保留完整退出码和关键结果。静态检查、单元测试、浏览器 E2E、构建和真实 IDE smoke 覆盖范围不同，不能互相替代。

### 当前 Browser E2E 证据

- Inspector 按钮只在 dev 页面出现。
- 操作 Inspector 按钮不会触发页面级 pointer 监听。
- Vue DOM 有 marker。
- `v-for` 多实例共享同一 AST sourceId。
- Teleport 内容保留 marker。
- Shift 命中 `inheritAttrs: false` 多根组件时选择调用方 marker。
- 选择模式阻止业务 click。
- `Esc` 退出后业务 click 恢复。
- tooltip 不展示路径或行列，Browser 协议不含这些字段。

以上在 Vite basic fixture 中合并为 7 项用例。Webpack basic fixture 的 1 项用例另覆盖真实 Loader、43 字符 marker、Runtime、WDS stream/hello 和 metadata request。发布门槛还需要 Element Plus 调用点、monorepo、HMR stale、多 tab 和真实 Bridge -> IDE 打开验证，不能由这两个 basic suite 替代。

### Extension 安全最低证据

- untrusted workspace 不连接和打开。
- session 损坏、过期和错误 token 被拒绝；Bridge 握手中的错误固定 subprotocol 被拒绝。
- `..`、绝对路径、UNC、URI、设备路径和编码路径被拒绝。
- 项目内 symlink/Junction 指向外部时被拒绝。
- multi-root 选择最长合法根。
- 未保存内容仅在上下文唯一匹配时校正。
- 重放 openRequestId 不重复打开，不同 payload 返回冲突。

## 打包 VSIX

根脚本会先构建扩展，再调用 `vsce package --no-dependencies`：

```powershell
pnpm package:vsix
```

预期文件：

```text
packages/vscode-extension/web-source-inspector.vsix
```

记录 SHA-256，供安装验证和分发比对：

```powershell
Get-FileHash packages/vscode-extension/web-source-inspector.vsix -Algorithm SHA256
```

列出 VSIX 内容：

```powershell
tar -tf packages/vscode-extension/web-source-inspector.vsix
```

检查 VSIX：

- 包含 `extension/dist/extension.js`、manifest、LICENSE 和必要文档。
- 不包含 fixtures、tests、session JSON、`.env`、token、用户目录或无关源码。
- 不携带完整 workspace `node_modules`。
- 若 bundle 含 `ws` 等第三方实现，包含 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 或等价版权通知。
- `main` 指向实际打包入口。
- `publisher`、displayName、version、engines、commands 和 settings 正确。
- 不使用 proposed API。

## VS Code 安装 smoke

1. 打开 Extensions 视图并选择 **Install from VSIX...**。
2. 安装刚打包的文件并 reload。
3. 打开本地受信任的 basic fixture workspace。
4. 启动 fixture Vite dev server。
5. 确认状态栏发现并连接 session。
6. 浏览器选择普通元素，记录打开的 URI、行列和 selection。
7. 验证 `v-for`、Teleport、未连接、stale、退出恢复。
8. 执行 Show Diagnostics，确认内容脱敏。

可选 CLI 安装：

```powershell
code --install-extension packages/vscode-extension/web-source-inspector.vsix --force
```

源码打开能力本身不得依赖 `code` CLI。

## Cursor 安装 smoke

使用同一个 VSIX 重复 VS Code 清单，并额外记录：

- Cursor 精确版本和 Extension Host 类型。
- 命令、状态栏、Quick Pick、打开/selection/reveal 是否一致。
- `vscode.env.appName` 被识别为 Cursor。
- 与 VS Code 同时打开项目时不会广播双开。

可选 CLI：

```powershell
cursor --install-extension packages/vscode-extension/web-source-inspector.vsix --force
```

CLI 不可用时使用 Extensions 图形界面。不能仅凭“Cursor 兼容 VS Code API”声明 smoke 通过。

## npm 包检查

发布 npm 前，对每个包执行构建并检查 `files` 范围、exports、types 和 peerDependencies。重点确认：

- `vite-plugin` 将 Vite 保持为 peer dependency。
- Runtime 不引入 Vue 运行时依赖。
- workspace 内部依赖在发布产物中解析为合法版本，不残留不可消费的本地路径。
- sourcemap 是否包含本机绝对路径。
- npm tarball 不含 tests、fixtures、session 文件或 secret。

可以在各包目录使用 `pnpm pack` 生成本地 tarball并检查内容；实际发布命令和 registry 凭据应由发布负责人在确认版本、权限和双因素认证后执行，凭据不得写入仓库或日志。

## 消费项目生产核验

至少选择两个真实消费项目：一个 Vue/Vite 项目，以及一个 Vue/Webpack 或 Vue CLI 项目。两类项目都必须执行生产构建和相同的产物扫描，不能用其中一类替代另一类：

```powershell
pnpm --filter <vite-app> build
rg -n "data-wsi-(source|component-source)|wsi:browser:|web-source-inspector:client|wsi\.bridge|/wsi/" <vite-dist>
rg -n "\b[A-Za-z]:[\\\\/]" <vite-dist>

pnpm --filter <webpack-or-vue-cli-app> build
rg -n "data-wsi-(source|component-source)|wsi:browser:|web-source-inspector:client|wsi\.bridge|/wsi/" <webpack-dist>
rg -n "\b[A-Za-z]:[\\\\/]" <webpack-dist>
```

两类产物都预期无命中。还应分别对浏览器实际加载的 JS/CSS 检查没有 Inspector 按钮、marker、WebSocket Bridge 或绝对源码路径。

## 发布文档清单

- README 与快速开始。
- Vue/Vite 接入和配置项。
- VSIX 安装说明。
- 精确/近似/不支持能力矩阵。
- Adapter authoring 约束与公共接口边界。
- 架构、协议与安全模型。
- 故障排查。
- 协议兼容表和 Vue/Vite fixture 矩阵。
- CHANGELOG。
- LICENSE、第三方 NOTICE 评估和 SECURITY 联系方式。

当前对应文档为 [capabilities.md](capabilities.md)、[adapter-authoring.md](adapter-authoring.md)、[CHANGELOG.md](../CHANGELOG.md)、[SECURITY.md](../SECURITY.md) 和 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 证据记录模板

每个候选版本至少记录：

```text
version:
date/timezone:
node/pnpm:
os:
vue/vite fixtures:
typecheck:
unit tests:
browser e2e:
build:
vsix path + sha256:
VS Code version + smoke result:
Cursor version + smoke result:
consumer production scan:
known residual risks:
```

没有当次验证证据时，应标记“未验证”，不能沿用旧版本结论。
