# Universal Vue Source Inspector Implementation Plan

状态：实施中；用户已确认实施计划。

## 目标

在现有 `D:\otherProject\web-source-inspector` 基线上，把当前 Vue 3 + Vite 实现演进为一个公开 `web-source-inspector` npm 包和一个同时支持 VS Code/Cursor 的 VSIX。业务项目执行一次 `npx web-source-inspector init` 或在扩展中执行 Enable Project 后，继续使用原有开发命令，即可在本地开发页面点击 `.vue` HTML template 元素并打开正确源文件位置。

首发声明范围：Vue 2.6/2.7、Vue 3.2+；Vite 2～6 的已验证 tuple；Webpack 4/5、Vue CLI 3/4/5 的已验证 tuple；`.vue` 普通 HTML template。JS/TS、Options API、Composition API 和 toolchain 支持的 `script setup` 不改变 template 定位语义。

## 影响范围

保留并改造：

- `packages/protocol`：改为 bundler-neutral Browser/Dev Server/IDE/CLI JSON 协议，移除 Browser 路径 metadata。
- `packages/compiler-core`：完整 HMAC sourceId、collision fail-closed、generation、Manifest staging。
- `packages/transform-vue`：保留目录，拆 common、Vue 2.6、Vue 2.7、Vue 3.2+ compiler adapter。
- `packages/runtime`：引入 `BrowserTransport`，移除路径/行列 tooltip 数据依赖，补 Vue 2 owner 解析。
- `packages/vite-plugin`：保留为 Vite Adapter，迁出 dev-session 共用逻辑并改为纯 factory/真实 `configureServer` session。
- `packages/vscode-extension`：改为 `web-source-inspector-vscode`，提供 Enable/View Plan/Doctor/Disable 和本地 CLI JSON 调用。

新增 workspace 包：

- `packages/dev-session-core`：Browser Router、Bridge、session descriptor、credentials、生命周期和 bundler-neutral transport。
- `packages/adapter-webpack`：Webpack Plugin、template Loader、build metadata、Manifest staging、WDS middleware、raw loopback transport。
- `packages/init-core`：detect/profile、AST plan/apply/remove、doctor、fingerprint、transaction journal、JSON API。
- `packages/web-source-inspector`：唯一公开 npm 包、CLI、Vite/webpack exports、Node 16 CJS/ESM 构建和 runtime/loader 资产。

内部 workspace 包全部设置 `private: true`，只发布一个 npm tarball；VSIX 单独发布但不与 npm 包共用运行代码入口。

## 依赖顺序

```text
protocol -> compiler-core -> transform-vue
protocol -> runtime
protocol + compiler-core -> dev-session-core
transform-vue + runtime + dev-session-core -> vite-plugin / adapter-webpack
vite-plugin + adapter-webpack + init-core -> web-source-inspector
protocol -> vscode-extension --spawn--> workspace web-source-inspector CLI
```

每阶段完成后先做该阶段的静态检查和聚焦验证，再进入下一阶段；不在未解决的上游协议/loader 合同上叠加实现。

## 阶段 0：基线与兼容性闸门

1. 记录当前 `packages/vite-plugin`、`packages/transform-vue`、`packages/runtime`、`packages/vscode-extension` 的公开 exports、现有 fixture 入口和运行中的 basic fixture；不停止或覆盖现有 `http://127.0.0.1:41730/` 进程。
2. 增加 fixture 版本锁定文件和可重复安装脚本，明确 Node 16.20.2 smoke 与 Vite 6/VS Code 当前 Node 的分离要求。
3. 建立 Webpack loader spike fixture，分别安装 vue-loader 15/16/17、Webpack 4/5，验证原始 rule 写入 `[web-source-inspector-loader, vue-loader]` 后实际 template request 的 `this.loaders`/`loaderIndex`、输入内容、map/meta 和最终 DOM marker。
4. 若任一版本不能满足 `selector -> WSI -> template compiler`，在 `adapter-webpack` 中固化该版本独立 rule recipe；不得用私有 RuleSet 猜测替代实测。

验证：只读扫描 package/fixture 版本并确认 Node 16.20.2 执行环境可用；Webpack spike 只证明 loader chain，不作为最终功能完成。公开包入口 smoke 在阶段 3 建立包骨架后开始，完整 Vite/Webpack subpath smoke 在对应 Adapter 完成后执行。

## 阶段 1：协议、Compiler Core 与会话核心

### 1.1 Protocol

修改 `packages/protocol/src/types.ts`、`constants.ts`、`validation.ts`：

- 将 Vite 命名改为 bundler-neutral Browser/Server/IDE 事件。
- Browser payload 仅保留 opaque sourceId、session/page/request、状态和错误；删除 relativePath、range、candidate position 的 Browser metadata/open-result 字段。
- 增加独立 browser token audience/TTL、session/page binding、CLI JSON envelope、`PLAN_STALE`、`RECOVERY_REQUIRED`、`TRANSACTION_CONFLICT`、`TEMPLATE_PIPELINE_MISMATCH` 等稳定错误码。
- 统一 byte limits、TTL、连接容量、Origin/loopback 校验输入和 Node 16 可用类型。

### 1.2 Compiler Core

修改 `packages/compiler-core/src/source-id.ts`、`types.ts`、`manifest.ts`、`digest.ts`：

- 使用 session HMAC-SHA-256，完整 256-bit base64url，不做截断或后缀消歧。
- HMAC 输入包含规范 relative path、module generation、node kind/tag、完整范围和局部 digest；新 session 必须轮换，当前 session 同 digest/generation 稳定。
- 不同 SourceRecord 共享 sourceId 时直接返回 collision error；Manifest 在成功构建前只写 staging。
- 增加按 `(moduleId, fullDigest)` 稳定 generation allocator、failed build 保留上一代、成功提交前的 compiler/compilation/buildId 绑定、stale tombstone。

### 1.3 Dev Session Core

从 `packages/vite-plugin/src/bridge.ts`、`bridge-types.ts`、`browser-router.ts`、`session.ts` 迁移逻辑到新包；迁移期间可保留原文件 re-export，确认无引用后再删除。

- 新增独立 CSPRNG credentials：HMAC key、browser token、IDE Bridge token 互不复用。
- 将 Browser Router 改为不向 Browser 回传路径/范围；选择请求只把当前 Manifest sourceId 和 modifier 送到 server。
- 保留 loopback Bridge、descriptor 原子写入、PID/TTL/claim、多 tab/server/IDE 路由和 Extension 侧路径复核。
- 提供 bundler-neutral `DevSession` 和 server-side `BrowserConnection` 合同，生命周期关闭时清理 token、routes、stream/socket、descriptor、timer 和 registry；它不依赖 Browser Runtime。阶段 2 的 Runtime `BrowserTransport` 只消费 protocol 事件，再由各 Adapter 连接到 BrowserConnection。

验证：现有 Vue 3/Vite basic 的 protocol、Bridge、Browser Router 单测与人工静态检查；Browser payload 快照不得出现 relativePath/range。

## 阶段 2：Runtime 与 Vue Transform 适配

### 2.1 Runtime

修改 `packages/runtime/src/types.ts`、`runtime.ts`、`view.ts`、`dom.ts`：

- `RuntimeTransport` 升级为 `BrowserTransport`，补 `dispose`、message validator 和 token/session binding。
- tooltip 只显示标签/组件名、连接/选择状态；路径和行列只在 IDE 侧可见。
- 保持 capture 阶段事件隔离、Shadow DOM、single-shot、Esc/HMR dispose、pointermove RAF 节流和 hit tester 清理。
- 增加 Vue 2 owner 链候选，同时保留 Vue 3 owner 链和第三方组件调用点规则。

### 2.2 Transform common/Vue 2/Vue 3

保留 `packages/transform-vue` 目录，拆出 `src/common`、`src/vue2`、`src/vue3`、`compiler-resolution.ts`、`range.ts`、`records.ts`：

- Vue 2.6 使用项目同版本 `vue-template-compiler`；Vue 2.7 使用项目 `vue/compiler-sfc`/实际 plugin compiler；Vue 3.2+ 使用项目匹配的 `@vue/compiler-sfc`/`compiler-dom`。
- Transform API 注入 compiler/parser，不静态绑定当前 workspace 的 Vue 3.5 依赖。
- 统一 UTF-16 1-based 坐标、BOM/CRLF/Unicode/中文路径、普通 HTML template、marker 冲突诊断、sourcemap 不新增绝对路径。
- Vue 2.6 单根与 Vue 2 slot；Vue 2.7 Composition API/script setup 支持；Vue 3 Fragment/多根/Teleport/script setup；Pug、external src、JSX/TSX/render 保持不支持。

验证：先保持现有 Vue 3 transform 单测，再增加 Vue 2.6/2.7 compiler fixtures、collision/stale/generation、sourcemap 和 marker conflict。

## 阶段 3：统一 npm 包与 init-core

### 3.1 Public package build contract

新增 `packages/web-source-inspector/package.json`、`src/index.ts`、`src/cli.ts`、`src/vite.ts`、`src/webpack.ts`、`src/webpack-loader.ts` 和双格式构建配置：

- `bin.web-source-inspector -> cli.cjs`，`engines.node >=16.20.2`。
- `exports["."]` 提供根入口的 types/import/require 条件；`./vite` 同时提供 types/import ESM/require CJS；`./webpack` 同时提供 types/require CJS/import ESM。每个入口使用对应 declaration，Webpack 入口导出 `WebSourceInspectorWebpackPlugin.loaderPath` 和 `createWebSourceInspectorBrowserMiddleware`。
- Browser runtime 和 webpack loader 作为显式构建资产打包，消费项目不使用 `import.meta.resolve` 或绝对磁盘路径拼接。
- Vue/Vite/Webpack/vue-loader/compiler/WDS 为 optional peerDependencies；内部 workspace 依赖全部 bundle/private。
- 根 `package.json`、workspace filters、tsconfig paths、build scripts 和 Extension package filter 改为区分公开 npm 包与 VSIX 包。

本阶段先验证 Node 16.20.2 可加载 CLI/init-core 和 package exports 骨架；`./vite`、`./webpack` 的完整 import/require 行为分别在阶段 4/5 Adapter 接入后验证。发布候选阶段再检查 tarball 只含 package.json、声明、运行代码、README、LICENSE/NOTICE。

### 3.2 Detect/Profile

新增 `packages/init-core/src/detect/*`：

- 从 workspace package manager/lockfile、实际可解析依赖和 dev scripts 检测 Vue、Vite/plugin-vue、Webpack、Vue CLI、vue-loader、compiler、WDS、配置模块格式和唯一运行入口。
- Vue 2.6/2.7 compiler 选择严格分流；Vite 与 Webpack 双入口、raw origin 未知、MultiCompiler、动态 mode 只产出稳定诊断或 requiredInputs。
- 识别标准 AST 白名单，明确拒绝 config array、外部 merge factory、多分支返回、computed/dynamic rules 和不可安全包装的 WDS hook。

### 3.3 Plan/Apply/Remove/Doctor

新增 `src/ast/*`、`src/plan/*`、`src/state/*`、`src/transaction/*`、`src/doctor/*`：

- Vite：加入 `webSourceInspector()` 且位于 Vue plugin 前。
- Webpack：在 `.vue` rule 的 vue-loader 前加入 Loader、加入 Plugin；WDS3 包装 `before`，WDS4.7+ 包装 `setupMiddlewares`；raw watch 记录精确 allowedOrigins。
- Vue CLI：通过 chainWebpack `.before('vue-loader')` 和 Plugin/WDS hook 完成最小 AST 修改。
- Plan 记录 beforeDigest/ABSENT、canonical root、realpath/lstat/file identity、created/reused fingerprint、normalizedAnswers、output digest 和 operation-domain planDigest。
- Apply/remove 使用项目锁、pending journal preflight、PLAN_STALE、逐文件原子写、私有 snapshot、afterIdentity 和冲突恢复条件；journal 在写 temp 前登记 root-relative tempName，独占创建后登记 tempIdentity，flush 后登记 afterDigest/rename intent，`ABSENT` 回滚只删除 identity/digest 匹配的普通文件。
- `.web-source-inspector.json` 只记录 schema、profile、相对配置路径和节点所有权/fingerprint，不记录 token/绝对路径/源码。
- JSON API 固定 `init/remove --json --phase plan|apply`、`doctor --json`、`--plan-digest` 和重复 `--answer`；交互 CLI 只是 plan/diff/confirm/apply 薄封装。

验证：对象/defineConfig/单返回函数/ESM/CJS/TS/Vue CLI 标准配置；幂等、PLAN_STALE、created/reused remove、pending journal、symlink/Junction、失败回滚和 Extension/CLI plan 字节级一致。

## 阶段 4：Vite Adapter 通用化

修改 `packages/vite-plugin/src/index.ts`、`client-module.ts`、`types.ts` 并接入 dev-session-core：

- factory/configResolved 纯；仅真实 `configureServer` 且 command serve 创建 session，preview/build 完全 no-op。
- 使用消费项目 compiler 的 Vue 2/2.7/3 transform；WSI pre-transform 只 staging，待下游 Vue transform/HMR 成功后提交 Manifest。
- 为 Vite HMR custom event 加 browser token、page/socket/Origin/Host/loopback 验证，移除 Browser metadata path response；Vite 2～6 分别固化 handshake 取值配方，无法取得时只允许精确 allowedOrigins 的独立 loopback fallback，HTTPS 无同源 transport 则该 tuple fail-closed。
- Runtime 注入使用显式构建资产；关闭时清理所有 transport/session 资源。

Fixture：Vue 2.6 + Vite 2 + `vite-plugin-vue2` 2.x；Vue 2.7 + Vite 3 + `@vitejs/plugin-vue2` 2.x；Vue 3.2 + Vite 2 + `@vitejs/plugin-vue` 2.x；Vue 3.3 + Vite 4 + `@vitejs/plugin-vue` 4.x；Vue 3.4 + Vite 5 + `@vitejs/plugin-vue` 5.x；Vue 3.5 + Vite 6 + `@vitejs/plugin-vue` 5.2.x。逐 tuple 验证 dev/HMR/failure/production/preview。

## 阶段 5：Webpack Plugin、Loader 与 Browser Transport

### 5.1 Plugin/Loader

新增 `packages/adapter-webpack/src/plugin.ts`、`loader.ts`、`registry.ts`、`build-metadata.ts`、`generation.ts`、`vue-rule.ts`、`runtime-entry.ts`：

- `apply` 首先检查最终 `compiler.options.mode === 'development'`；constructor/top-level/factory 无随机或监听副作用。
- 版本化修改原始 Vue rule，使最终 template chain 为 selector -> WSI -> compiler；raw/script/style/unsupported/production 透传且保留 map/meta。
- template Loader 读取 compiler input filesystem 的完整 SFC，生成完整坐标和 server-only metadata；sourceId collision 直接 compilation error。
- sessionEpoch + compiler/adapter/schema 进入 loader identity；Webpack5 metadata 可恢复，cache-loader 不能恢复时只禁用 WSI template cache。
- staging 绑定 compiler/compilation/buildId；只有最终无错且未 supersede 才提交 Manifest，失败保留上一代。
- 多 entry 用 global guard；首版阻断 MultiCompiler/config array；thread-loader 只在 Inspector development 中关闭或移到主进程。

### 5.2 WDS/raw transport

- WDS3 `before` 挂载同源 POST stream middleware，WDS4.7+ `setupMiddlewares` 在用户 middleware 前插入 entry；factory 无 session 返回 null。包装器只调用用户 hook 一次，并原样保留 `this`、参数、返回值及全部用户 middleware 的相对顺序。
- WDS HTTP/HTTPS 使用独立 browser token、random path、loopback、Origin/Host、size/heartbeat/capacity 校验；POST stream open 避免 GET 缺 Origin。
- raw Webpack watch 使用独立 loopback WebSocket、精确 allowedOrigins；custom HTTPS 首版只支持显式 middleware mount。
- Runtime entry 注入一次并清理 stream/socket/session。

精确 fixture：Vue 2.6 + Vue CLI 3 + Webpack 4 + vue-loader 15 + WDS 3.x；Vue 2.6 + Vue CLI 4 + Webpack 4 + vue-loader 15 + WDS 3.x；Vue 3.2 + Vue CLI 5 + Webpack 5 + vue-loader 17 + WDS 4.7+；Vue 2.6 + raw Webpack 4 + vue-loader 15；Vue 2.7 + raw Webpack 5 + vue-loader 15；Vue 3.2 + raw Webpack 4/5 + vue-loader 16；Vue 3.5 + Webpack 5 + vue-loader 17 + WDS 4.7+。任何 loader chain 不一致不得合并共享 recipe。

阶段 5 完成后，用真实 Node 16.20.2 同时验证 `require/import('web-source-inspector/vite')` 与 `require/import('web-source-inspector/webpack')`，并从打包 tarball 安装到最小 Vite/Webpack fixture，不能只从 workspace symlink 加载。

## 阶段 6：Extension 项目管理

修改 `packages/vscode-extension/package.json`、`src/extension.ts`、`controller.ts`、`initializeProject.ts`，新增 `projectCli.ts`、`integrationPlan.ts`、`projectStatus.ts`：

- package name 改为 `web-source-inspector-vscode`，保留 displayName 和 VSIX 语义。
- `Source Inspector: Enable Project`、View Integration Plan、Run Doctor、Disable Project；状态栏显示未安装/未启用/等待 dev server/已连接/冲突。
- 仅在 trusted local workspace 解析 workspace `node_modules/web-source-inspector`，无 shell 拼接、无全局包、无 workspace 外加载；参数数组调用 CLI JSON。
- Diff 预览后回传 planDigest + normalizedAnswers；PLAN_STALE 重新打开计划；remove 只显示 created 节点。
- 保留现有 Bridge/source opener 的 realpath、workspace、symlink/Junction、stale 和 unsaved context 安全边界；不再自己生成 Vite 建议。

验证：trusted/untrusted/remote、缺 npm 包安装提示、CLI/Extension plan 一致、Enable/Disable 幂等、VS Code 和 Cursor 最终 VSIX smoke。

## 阶段 7：矩阵、生产与发布

1. 完成所有 Vite/Webpack/Vue CLI/raw fixture 的 browser/IDE E2E：普通元素、v-for、条件、slot、组件调用点、Vue3 Teleport/Fragment、Vue2.7 script setup、第三方组件、HMR stale、多 tab/server/IDE、事件隔离和 disable 恢复。
2. 运行生命周期 fail-closed 检查：`vite serve --mode production` 作为真实 dev server 启用；`vite build --mode development` 与 `vite preview` 禁用且无 WSI marker/runtime event/transport path/session descriptor/token/绝对 workspace path；WDS 静态 wrapper 可存在但不挂载；一次性 Webpack `mode: 'development'` build 不声明可用 session。
3. 使用真实 Node 16.20.2 做 CLI/CJS/ESM smoke，Vite6/VS Code/Cursor 按自身 Node 要求单独核验。
4. 打包唯一 npm tarball 和 VSIX，检查 package.json/声明/运行代码/README/LICENSE/NOTICE 白名单；VSIX 不含源码、测试、fixture、sourcemap、token 或无关依赖。
5. 更新 `docs/quick-start.md`、`architecture.md`、`protocol.md`、`security.md`、`capabilities.md`、`release.md`，发布支持 tuple 和未验证边界。

## 验证与停止条件

实现阶段按风险执行聚焦验证：协议/核心单测 -> transform fixture -> bundler fixture -> Browser/IDE E2E -> Node16/package/production scan。任何命令失败读取完整错误并回到对应阶段，不叠加猜测式补丁。不开启 Git 操作；删除旧文件前先用 rg 确认无引用并保留 re-export 过渡。

## 主要风险

- vue-loader 15/16/17 的真实 template chain 和 cache metadata 是最高风险，阶段 0/5.1 为硬闸门。
- Vue 2.6/2.7 compiler API、Vite plugin peer range、Node16 与 Vite6 Node 要求存在版本分裂，必须按 tuple 锁定。
- WDS3/4 hook 生命周期、HTTP/HTTPS Origin 和流式连接清理容易造成浏览器无法连接或生产残留。
- AST 动态配置、TOCTOU、journal 恢复和 remove ownership 可能破坏用户配置，任何不确定形态必须拒绝自动写入。
- 单一 npm tarball 与 VSIX 的 runtime asset/loaderPath 解析若不稳定，会在真实消费项目中失效；发布前必须 Node16 + tarball 安装 smoke。
