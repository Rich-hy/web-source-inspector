# 发布与 VSIX

本文定义 `0.x` 阶段的发布门槛。命令均在仓库根执行，不包含 Git 操作。

## 发布单元

| 单元 | 产物 |
| --- | --- |
| `web-source-inspector` | 唯一公开 npm tarball，包含 CLI、Vite/Webpack 导出和物理 runtime/loader 资产 |
| `web-source-inspector-vscode` | VS Code/Cursor 共用 VSIX，文件名为 `web-source-inspector.vsix` |

`@web-source-inspector/*` workspace 包均为内部私有实现，不单独发布。未来 Three.js、React 或其它框架 adapter 是否拆包，需要在公共 API 稳定后单独评审。

当前发布候选的 npm 产品基线为 `web-source-inspector@0.1.0-beta.4`，对应手动安装的 VSIX `web-source-inspector-vscode@0.1.1`。两者的发布状态彼此独立，且该记录不代表 npm registry、VS Code Marketplace 或 Cursor 的实际发布状态；每次发布前都必须分别查询和记录。

## 独立版本与发布

npm 包和 VSIX 是两个独立发布单元：

1. 为公开 npm 包确定版本，构建并检查 tarball，再按目标 dist-tag 发布到 npm。
2. 为扩展 manifest 确定版本，构建并检查 VSIX，再单独上传到目标 marketplace 或分发该 VSIX。
3. `npm publish` 不会发布或更新 VSIX；上传 VSIX 也不会安装或更新消费者项目内的 npm 依赖。
4. 消费者需要兼容的 VSIX 与项目本地 `web-source-inspector` 依赖。扩展只能调用工作区内 CLI，展示可审阅 diff，并在用户确认后写入静态安全配置；扩展不会自动安装依赖，也不支持仅安装扩展的零项目改动流程。

不在本文件中提前声明某个本地 tgz、VSIX、测试结果或 smoke 结果为当前发布证据。它们必须由本次候选版本的实际命令和安装验证重新生成。

## 版本规则

- 所有包遵循 SemVer。
- protocol major 变化需要 Runtime、Vite/Webpack Adapter、公开包和 Extension 协调发布。
- 同 major 的新增能力通过 capabilities 协商，不以包版本猜测功能。
- session 文件使用独立 `schemaVersion`；不兼容 schema 必须明确拒绝或提供受测迁移读取。
- server 与 extension 可以版本不同，但必须通过协议和 capability 验证。
- Vue/Vite/Webpack/Vue CLI 支持范围以代码中的兼容性门槛为准，并由 fixture 和真实消费项目验证；范围命中仍必须通过实际 Vue plugin、`vue-loader`、compiler、webpack-dev-server 与上游 peer dependency 校验。
- 配置弃用至少保留一个 minor 周期，并给出替代项和删除版本。

## 当前基线：同机网卡 IP

`browserAccess` 默认 `same-machine`，Vite 在项目自身的 `server.host` 已允许本机网卡访问时无需额外插件配置。初始化流程不会修改 `server.host`。显式 `browserAccess: 'loopback'` 保留为只允许回环浏览器的收紧选项。Bridge 始终监听 `127.0.0.1`。发布记录必须分别保留：实际 listener 端口与冻结 `devOrigins`、localhost/127.0.0.1/本机网卡 IP 的开发态证据，以及生产构建无 Runtime/Bridge 特征的扫描结果。没有第二设备或隔离 VM 的拒绝证据时，只能声明本机网卡 IP 可用，不能声明远端设备已验证拒绝。代理、端口转发、WSL、Docker、Dev Container 和 Remote SSH 不支持。

Raw Webpack watch 仅接受精确的 `http:` Origin；`https:` Origin 不支持且必须拒绝。Webpack dev-server 仅支持 3.x 或 `>=4.7.0 <5.0.0`。

兼容性范围：Vue 2.6 为 `>=2.6.0 <2.7.0`，Vue 2.7 为 `>=2.7.0 <2.8.0`，Vue 3 为 `>=3.2.0 <4.0.0`；Vite 为 `>=2.9.0 <7.0.0`，Webpack 为 `>=4.0.0 <6.0.0`，Vue CLI 为 3 至 5。每个候选项目还必须满足实际 Vue plugin、`vue-loader`、compiler、webpack-dev-server 和上游 peer dependency 兼容性；不能将这些范围解释为任意版本组合均可用。Vue 2.6 的 `vue-template-compiler` 必须与实际 `vue` 完整版本一致；Vue 2.7 必须能从实际 `vue` package anchor 解析 `vue/compiler-sfc`，不要求独立 `@vue/compiler-*` 包完整版本相等；Vue 3 的 `@vue/compiler-sfc` 与 `@vue/compiler-dom` 必须都存在，且各自完整版本等于实际 `vue`。

`vue-loader` 15/16/17 官方没有 Vue peer，因此 Vue family 不因缺失该 peer 被阻断：应由实际 `vue/package.json` 版本判定，并继续满足对应 Vue family 的 compiler 证据要求。对于 Webpack/Vue CLI，再校验 `vue-loader` 主版本与该 Vue family 匹配且其 webpack peer 满足要求；Vite 不使用 `vue-loader`。

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

### Browser E2E 必要覆盖范围

- Inspector 按钮只在 dev 页面出现。
- 操作 Inspector 按钮不会触发页面级 pointer 监听。
- Vue DOM 有 marker。
- `v-for` 多实例共享同一 AST sourceId。
- Teleport 内容保留 marker。
- Shift 命中 `inheritAttrs: false` 多根组件时选择调用方 marker。
- 选择模式阻止业务 click。
- `Esc` 退出后业务 click 恢复。
- tooltip 不展示路径或行列，Browser 协议不含这些字段。

Vite 与 Webpack basic fixture 都必须覆盖各自的真实运行时、marker、Loader 或 plugin 注入、开发服务器握手和 metadata 请求。发布门槛还需要 Element Plus 调用点、monorepo、HMR stale、多 tab 和真实 Browser -> Bridge -> IDE 打开验证，不能由 basic suite 替代。

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
