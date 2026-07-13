# Universal Vue Source Inspector Design

状态：设计规格已复核；实施计划待用户确认后进入功能编码。

日期：2026-07-10

## 1. 背景

当前仓库已经实现 Vue 3.5 + Vite 6 的 DOM 到 Vue SFC template 定位闭环，包括编译期 marker、Browser Runtime、Loopback Bridge、VS Code/Cursor Extension、路径安全和本地 VSIX。

目标产品不是要求用户理解上述内部组件，而是提供统一体验：用户在 Cursor 或 VS Code 安装一次扩展，在业务项目安装一个 npm 包并进行一次明确初始化，之后继续运行原有开发命令，即可在浏览器点击元素并打开对应 `.vue` 文件的 template 标签。

现有 Vue 3 + Vite 实现作为第一个 Adapter 基线继续演进，不创建新的独立仓库。

## 2. 产品目标

首个通用版本必须满足：

- 同一个 VSIX 支持 VS Code 和 Cursor。
- 对外只暴露一个 npm 包 `web-source-inspector`。
- 支持 Vue 2、Vue 3。
- 同时支持 Vite、Vue CLI、Webpack 4 和 Webpack 5。
- `.vue` 的 script 使用 JavaScript 或 TypeScript 均不影响定位。
- 点击运行页面中的 Vue DOM 后，打开正确 `.vue` 文件并定位到对应 HTML template 标签。
- 用户不需要手工编辑构建配置；初始化器展示修改计划，经确认后自动完成最小配置修改。
- 初始化完成后继续使用项目原有 `npm run dev`、`pnpm dev` 或等效命令。
- 只在开发服务生效，生产构建完全不包含 Runtime、marker、Manifest 或 Bridge。

## 3. 非目标

首个通用版本不承诺：

- 纯 JavaScript/TypeScript 中的 `document.createElement`、`innerHTML` 字符串来源定位。
- JSX、TSX、Vue render 函数。
- Pug、MDX 或其它非 HTML template 预处理器。
- React、Svelte、Angular。
- Three.js/Canvas 对象级来源定位。
- Remote SSH、WSL、Dev Container、Codespaces 或远程浏览器。
- SSR/hydration 的服务端与客户端一致定位。
- 安装 npm 包时通过 `postinstall` 静默修改项目。

对于 `v-html` 或运行时字符串产生的子节点，只允许定位可信容器标签，不推测字符串内部节点来源。

## 4. 用户体验

### 4.1 安装

用户安装 VSIX 或市场扩展，然后在业务项目安装 npm 包：

```bash
npm install -D web-source-inspector
```

初始化提供两个等价入口。

命令行入口：

```bash
npx web-source-inspector init
```

扩展入口：

```text
Source Inspector: Enable Project
```

两个入口必须调用项目中安装的同一初始化核心，不允许 CLI 和 Extension 各自维护不同的项目识别或配置修改实现。

### 4.2 初始化交互

初始化采用 plan/apply 两阶段：

1. 读取 package manifest、锁文件和构建配置。
2. 识别 Vue、构建工具、vue-loader 和配置模块格式。
3. 生成只读修改计划。
4. 展示将修改的文件、插入的 import/require、插件位置和风险说明。
5. 用户明确确认后才写入。
6. 写入成功后提示重启开发服务。

检测到多个可用 Adapter，或 raw Webpack 无法从配置/脚本确定精确 allowedOrigins 时，plan 先返回结构化 `requiredInputs`；CLI prompt 或 Extension 控件收集用户选择后，用同一答案重新生成可确认计划。答案属于 planDigest 输入，不能在 apply 阶段临时改变。

Extension 状态栏在 npm 包已安装但项目未启用时显示“Source Inspector：项目未启用”，点击后打开相同 plan 预览。

不允许在 `postinstall` 中修改配置，不允许初始化器自动运行依赖安装，不允许在复杂配置无法安全解析时猜测修改。

### 4.3 日常使用

初始化完成后，用户继续运行原命令：

```bash
npm run dev
```

开发页面右下角显示 Inspector 图标。正常流程为：

1. Extension 自动发现匹配的本地开发会话。
2. 用户点击浏览器 Inspector 图标或从 IDE 开启选择模式。
3. hover 显示元素高亮和标签/组件名称；源码相对路径与行列不下发到浏览器。
4. 点击元素后，IDE 打开正确 `.vue` 文件并定位 template 标签起始位置。
5. 默认单次定位成功后退出；`Esc` 可随时退出。

### 4.4 管理命令

npm 包提供：

```bash
npx web-source-inspector init
npx web-source-inspector doctor
npx web-source-inspector remove
```

Extension 提供对应入口：

- `Source Inspector: Enable Project`
- `Source Inspector: View Integration Plan`
- `Source Inspector: Run Doctor`
- `Source Inspector: Disable Project`

`remove` 只删除初始化器能够证明由其加入的 AST 节点。若用户已经改写相关配置，必须生成移除计划或人工步骤，不得覆盖整个文件。

## 5. 定位语义

首版的必要正确性标准是“文件正确、template 标签正确”。

- 普通原生元素定位实际 `<div>`、`button`、SVG 等 template 标签。
- `v-for` 的多个运行实例定位同一个模板标签。
- 条件分支只定位当前渲染分支的 template 标签。
- 在 Vue/toolchain 支持 Teleport 时，其内容定位原始 SFC template，而不是目标容器。
- Slot 内容优先定位内容实际声明位置。
- 项目内自定义组件：普通点击优先实际 DOM template；组件候选定位调用标签。
- Element Plus 等第三方组件：不转换 `node_modules`，定位用户代码中的组件调用标签。
- 无法确认精确节点时只允许返回可信组件调用点或容器候选。
- 无可信候选时显示不支持，不猜测其它文件或相邻行。

Script 是 Options API、Composition API 或消费项目支持的 `script setup`，以及使用 JavaScript 或 TypeScript，均不改变 template 定位语义。

## 6. 总体架构

```text
Vue SFC
  -> Bundler Adapter
  -> Vue-version Transform
  -> DOM marker + server-side SourceRecord
  -> Browser Runtime
  -> Browser Transport
  -> Dev Session Core
  -> authenticated Loopback IDE Bridge
  -> VS Code/Cursor Extension
  -> open .vue file at template range
```

外部只暴露一个 npm 包，内部按职责拆分：

| 模块 | 职责 |
| --- | --- |
| `web-source-inspector` | 对外 npm 入口、CLI、Adapter 自动选择和公共配置 |
| `init-core` | 项目识别、AST plan/apply/remove、doctor |
| `protocol` | Browser、Dev Server、IDE 和初始化器版本协议 |
| `compiler-core` | SourceRecord、sourceId、Manifest、generation、stale 和候选 |
| `transform-vue2` | Vue 2 HTML template parser 与 marker 注入 |
| `transform-vue3` | Vue 3 HTML template parser 与 marker 注入 |
| `runtime` | Inspector UI、命中、高亮、事件隔离和 transport 抽象 |
| `dev-session-core` | bundler-neutral Manifest、Browser Router、Bridge 和 session 生命周期 |
| `adapter-vite` | Vite 生命周期、模块转换、HMR transport 和 Runtime 注入 |
| `adapter-webpack` | Webpack Plugin、Loader、entry 注入、watch/HMR 和 browser channel |
| `vscode-extension` | 会话发现、项目启用入口、Workspace Trust 和打开源码 |

这些可以是 monorepo 内部 workspace 包，但除 `web-source-inspector` 外全部标记为 `private` 并由统一 npm 包构建时捆绑，不单独发布；用户不需要选择或安装内部 Adapter。

当前 VSIX workspace package 使用了 npm 名称 `web-source-inspector`。为给统一 npm 入口保留该名称，实施时将 Extension manifest/package 名改为 `web-source-inspector-vscode`，displayName、命令前缀和 VSIX 文件名保持 Web Source Inspector 语义。当前尚未公开发布，不需要兼容既有 Marketplace extension ID。

统一 npm 包必须提供 Node 16 可加载的明确子路径 exports：

- `web-source-inspector`：CLI。
- `web-source-inspector/vite`：ESM 优先，同时提供兼容加载入口。
- `web-source-inspector/webpack`：可被 CommonJS Webpack/Vue CLI 配置 `require()`。

发布包合同固定为：`engines.node` 为 `>=16.20.2`，`bin.web-source-inspector` 指向 Node 16 可直接执行的 `cli.cjs`；`./vite` 同时提供 `import` ESM 与 `require` CJS compatibility entry；`./webpack` 同时提供 `require` CJS 与 `import` ESM wrapper；全部入口提供对应 TypeScript declaration。不得依赖 `npx` 猜测 package root，也不得让 CommonJS 配置同步 `require()` 一个纯 ESM 文件。

构建产物不得依赖 Node 20 才稳定的 `import.meta.resolve` 等 API。Runtime client 通过显式 package export/构建资产解析，不在消费项目中拼接绝对磁盘路径。Extension 继续独立 bundle，不要求消费项目加载 Extension 代码。

npm 包同时生成：

- 面向 Webpack/Vue CLI config 的 CommonJS Node 16.20.2 产物。
- 面向 Vite config 的 ESM 产物。
- Browser Runtime 的浏览器 ESM 产物。

Vue、Vite、Webpack、vue-loader、Vue compiler 和 webpack-dev-server 使用 optional peer dependency 声明，由消费项目提供并由 doctor 校验；初始化 AST 工具和 Bridge 运行依赖属于 npm 包自身依赖。

## 7. Adapter 选择

初始化器基于已安装依赖和配置文件生成唯一环境结论：

| 环境 | Adapter |
| --- | --- |
| Vue 2 + Vite | Vite Vue 2 Adapter |
| Vue 3 + Vite | Vite Vue 3 Adapter |
| Vue 2 + Webpack | Webpack Vue 2 Adapter |
| Vue 3 + Webpack | Webpack Vue 3 Adapter |
| Vue CLI | 根据 Vue、Webpack 和 vue-loader 实际版本选择 Webpack Adapter |

不得只根据配置文件名推断环境。检测至少核对 Vue、Vite/Webpack、Vue CLI、Vite Vue plugin、vue-loader 和 template compiler 的解析版本。

Vue 2.6 + Vite 识别社区 `vite-plugin-vue2`；Vue 2.7 + Vite 识别 `@vitejs/plugin-vue2`；Vue 3 识别对应版本的 `@vitejs/plugin-vue`。检测到 Vue 版本与 Vite Vue plugin 不匹配时，doctor 阻止启用。

同时检测到 Vite 与 Webpack 且无法确定运行入口时，初始化必须要求用户选择，不得默认修改两套配置。

## 8. Vue Transform

### 8.1 编译器选择

Transform 必须使用与消费项目 Vue 和 bundler toolchain 匹配的 parser：

- Vue 2.6：从项目解析与 `vue` 完全同版本的 `vue-template-compiler`，启用 source range。
- Vue 2.7：从项目解析 Vue 2.7 提供并由当前 bundler plugin/vue-loader 实际使用的 `vue/compiler-sfc` compiler 入口，不强制项目额外安装 `vue-template-compiler`。
- Vue 3.2+：从项目解析与 Vue toolchain 匹配的 `@vue/compiler-sfc` 和 `@vue/compiler-dom`。

不得把单一 Vue compiler 版本强行用于全部消费项目。doctor 校验“Vue 版本、Vite Vue plugin/vue-loader 和其实际 compiler”一致；Vue 2.6 中 `vue` 与 `vue-template-compiler` 版本不一致时必须阻止启用并给出修复命令，Vue 2.7 则验证 `vue/compiler-sfc` 可解析且版本匹配。

### 8.2 转换顺序

Vite 转换发生在 Vite Vue plugin 之前；Webpack 转换发生在 vue-loader 已选出 HTML template block 之后、template compiler 之前。两条路径共享以下语义步骤：

1. 解析完整 SFC，定位 HTML template block。
2. 使用对应 Vue parser 遍历 template AST。
3. 按完整文件坐标生成 SourceRecord。
4. 使用 session 专属随机密钥，对“规范化相对路径 + 模块 generation + 节点类型 + 标签名 + template 节点完整范围 + 局部源码 digest”的规范化元组执行 HMAC-SHA-256，生成完整 256-bit、base64url 编码且不包含路径明文的 sourceId。
5. 在模块和当前 compilation 暂存区检查 sourceId；同一记录重复注册视为幂等，不同记录出现相同 sourceId 时直接阻断 compilation，不做截断、加后缀或静默消歧。
6. 将最终 sourceId 注入原生元素或组件调用 marker。
7. 生成可回映原 SFC 的 sourcemap。
8. 再把结果交给 Vite Vue plugin 或 vue-loader template compiler。

坐标统一为 1-based 行列、UTF-16 offset 和 `[start, end)` 范围。必须覆盖 LF、CRLF、BOM、中文、emoji、tab、空格路径和中文路径。

sourcemap 只服务于构建链回映；它可能按消费 bundler 的常规开发策略被浏览器获取，但 WSI 生成或组合的 `sources`/`sourcesContent` 不得新增绝对磁盘路径、IDE token 或 WSI 私密凭据。Browser Transport/DOM/runtime 协议仍严格不下发 relativePath、range、源码上下文或候选位置。

### 8.3 Marker

保留两类内部属性：

- `data-wsi-source`：实际 DOM template 标签。
- `data-wsi-component-source`：组件调用标签。

用户 template 已声明同名属性时，不覆盖业务值；跳过该节点并输出结构化诊断。

Inspector 的 Browser 协议只提供不透明 sourceId、session/page/request 标识、连接/错误状态，以及仅能访问 Browser Transport 的短期 browser-scoped token；标签名等 hover 文案直接从命中 DOM 推导。relativePath、源码行列/范围、候选位置、绝对路径、源码上下文、IDE Bridge token 和完整 SourceRecord 都保留在开发服务端，不通过 metadata 或 open-result 回传浏览器。Browser token 与 IDE token 不得相同或相互换用。

session HMAC key、browser token 和 IDE Bridge token 分别用 CSPRNG 独立生成至少 256 bit，不互相派生、复用或被另一协议接受。browser token 绑定 session、page/connection、`browser-transport` audience 和 session TTL，只允许 hello/心跳/选择当前 Manifest sourceId 等 Browser Router 能力；IDE token 只接受 Bridge 协议。token 校验使用恒定时间比较，session 关闭后三类凭据和全部派生状态立即失效。

## 9. Vite Adapter

初始化器在 Vite config 中加入 `webSourceInspector()`，并保证它位于 Vue plugin 之前。

Vite Adapter 负责：

- `enforce: 'pre'` 转换匹配的 `.vue` SFC。
- 复用 Vite HMR custom events 作为 Browser Transport。
- 每条 Vite HMR 自定义事件校验 browser token、session/page/request 标识、socket 绑定和 loopback remote address；Adapter 按 Vite 主版本的已验证 handshake 取值配方自行校验精确 Origin/Host/协议，Vite `allowedHosts` 只是附加门而非唯一校验。若某个 Vite tuple 无法取得 handshake 信息，只能切换到带精确 `allowedOrigins` 的独立 loopback Browser Transport；HTTPS 页面在无法提供受信同源 transport 时 fail-closed，该 tuple 不得列入支持矩阵，不得使用未定义的 capability 绕过。
- 在开发 HTML 中注入 Browser Runtime 虚拟模块。
- WSI `enforce: 'pre'` transform 只把记录写入当前模块 staging；必须在同一模块的下游 Vue plugin transform 和本次 HMR/update 完成且无错误后，才按模块原子替换 Manifest，并保留有界 stale tombstone。WSI 成功但下游 Vue 编译失败时继续提供上一代成功记录。
- 文件删除时移除模块记录。
- Vite server 关闭时清理 Browser Router、Bridge 和 session descriptor。
- `apply: 'serve'`，生产 build 不执行任何 Inspector 转换或注入。

Vue 2 和 Vue 3 只在 compiler/marker transform 上分流，Browser Runtime、Manifest、Bridge 和 Extension 协议保持一致。

Vite Adapter 只在 `config.command === 'serve'` 且真实 `configureServer` dev-server 生命周期建立后创建 session。`build`、SSR build、`vite preview` 或无法确认是开发服务的生命周期一律 fail-closed，不注入 marker、Runtime、Manifest 或 Bridge；Vite preview 即使复用 serve 配置解析，也不能触发 session 创建。

Vite package 模块顶层和 `webSourceInspector()` factory/configResolved 必须保持纯，不在 `configureServer` 确认真实 dev-server 前生成密钥/token、创建 Manifest/session、写 descriptor 或注册监听。Vite 的 command 仅是必要条件而非充分条件：`vite serve --mode production` 仍是开发服务并可在 configureServer 启用，`vite build --mode development` 和 `vite preview` 均完全禁用。

## 10. Webpack 与 Vue CLI Adapter

### 10.1 Webpack Plugin

raw Webpack watch config 由初始化器加入 `WebSourceInspectorWebpackPlugin` 和 Vue rule 中的 Source Inspector Loader；webpack-dev-server 项目还需要加入 10.3 节的同源 transport hook。Adapter 负责：

- 识别 Webpack 4/5、vue-loader 15/16/17 和 Vue 主版本。
- 在 compiler 创建前找到唯一原始 Vue SFC rule，把 Loader 插在书写顺序中 vue-loader 之前，标准形态为 `[web-source-inspector-loader, vue-loader]`；vue-loader 15/16/17 的版本配方分别验证 VueLoaderPlugin/pitcher 确实把它放入 template block request 的正确阶段。
- 在 `afterPlugins` 只校验 VueLoaderPlugin 已安装、最终 rules 中 WSI/Vue rule 唯一且没有重复注入；真实 `type=template` 请求由 WSI Loader 执行时依据 `this.loaders`、`loaderIndex`、resourceQuery 和输入内容校验，证明 normal chain 的书写顺序为 `[..., web-source-inspector-loader, vue-loader block selector]`，按右到左执行即 selector -> Inspector -> template compiler；无法证明时阻断 compilation。
- 只有 `compiler.options.mode === 'development'` 时才允许启用；`watch`、webpack-dev-server 或一次性 compilation 本身都不能替代 development mode 判断。
- 为每个 compiler 和 compilation 建立隔离的 record staging 与 cache metadata registry。
- 注入一次 Browser Runtime bootstrap，使用全局 guard 防止多 entry 重复挂载。
- 在 rebuild、module invalidation 和删除时更新 Manifest generation。
- compilation/watch 关闭时释放端口、timer、socket、registry 和 session 文件。

raw Webpack 支持范围要求项目使用 webpack watch、webpack-dev-server 或其它保持 compiler 生命周期的本地开发服务。只执行一次 development build 后退出进程的静态产物没有存活的 Manifest/Bridge，不声明可点击定位。

运行时最终 `compiler.options.mode` 缺失或不是 `development` 时，Plugin 必须完全禁用并由 doctor 给出阻断诊断；不得因发现 `watch`、`devServer` 配置或 `NODE_ENV` 而推断为开发模式。函数配置、Vue CLI 或由命令参数决定 mode 时，只要 AST 插入本身可安全完成，初始化器可以写入并把动态 mode 标为诊断信息，最终一律以运行时 `compiler.options.mode` fail-closed。一次性 `mode: 'development'` build 可以正常产出业务 bundle，但 Inspector 不声明存在可用 session。

Webpack package 模块顶层和 Plugin constructor 只保存不可变配置，不生成随机值或注册资源。`apply(compiler)` 的第一项操作是检查最终 `compiler.options.mode`；未通过时在注册 compiler hook、改写 rule/entry/cache、创建 registry/密钥/token/session 或监听任何端口之前返回。永久配置中的 Loader 和 WDS middleware 在没有 development registry 时均为纯透传。

### 10.2 Loader 与并发

Webpack loader normal phase 按 `use` 数组从右到左执行，但 vue-loader 还会通过 VueLoaderPlugin/pitcher 重排并拆出 block 子请求。初始化器必须在 VueLoaderPlugin 应用前把 Source Inspector Loader 写在 vue-loader 左侧，原始标准 rule 为 `[web-source-inspector-loader, vue-loader]`。权威结果是最终 template request 的 normal chain 为 `[..., web-source-inspector-loader, vue-loader block selector]`：selector 先输出原始 HTML template 内容，Source Inspector Loader 再注入 marker，最后交给左侧 template compiler。版本 Adapter 必须实测并验证这一结果，不能仅凭原始数组推断；Loader 出现在空 query/raw 请求中时只原样透传。

`web-source-inspector/webpack` 通过 `WebSourceInspectorWebpackPlugin.loaderPath` 暴露已发布 Loader 的绝对解析结果；初始化器在配置 AST 中引用该属性，不硬编码 tarball 内部 `dist` 路径，也不要求用户安装第二个 loader 包。

Loader 只处理经各版本 query parser 判定为 Vue `type=template` 的子请求；是否为 HTML 以重新解析原始 SFC 后的 `template.lang` 缺失或等于 `html` 为准，不能要求默认 query 必须携带 `lang=html`。script、style、custom block、空 query、未知 query、unsupported template lang 和 production/no-registry 路径全部原样透传且不注册 SourceRecord，并保留 incoming sourceMap、loader additionalData/meta 和 callback 参数的 identity；不能因旁路分支截断 vue-loader 的后续映射。它通过 compiler input filesystem 读取同一原始 SFC，使用 8.1 节的匹配 compiler 确认 template block、完整文件坐标和输入内容；block 内容、loader 相对顺序或 sourcemap 无法对应时，以 `TEMPLATE_PIPELINE_MISMATCH` 阻断，而不是在错误阶段注入。vue-loader 15、16、17 分别由版本 Adapter 解析其 query 编码并验证有效请求链，不能用一个未验证的内部路径猜测全部版本。

Source Inspector Loader 返回转换后的 template 内容和可回映完整 SFC 的组合 sourcemap，同时把 server-only WsiBuildMetadata 写入模块 build metadata。Metadata 至少包含 schemaVersion、sessionEpoch、compilerSessionId、规范 moduleId、完整输入 digest、generation 和 SourceRecord；不得进入生成的浏览器模块 exports 或 bundle。当前 compilation/buildId 由 Plugin 读取 metadata 时绑定到 staging，不写入可跨 build 恢复的 metadata。暂存区使用完整 256-bit HMAC sourceId；同一 sourceId 对应不同 SourceRecord 时向 compilation 写入错误并阻断本次提交。

sessionEpoch 每个 Plugin 活动 session 独立随机生成，在一次 watch/dev-server 生命周期内稳定，session 关闭后轮换。Plugin 必须在首次 compilation 前把 epoch、Adapter/compiler/schema 版本注入每个 WSI loader options/request identity；新进程必须冷失效旧 transform cache。它本身不是密钥，可以出现在 loader request/cache key。generation allocator 对同一 session 内的 `(moduleId, 完整输入 digest)` 返回稳定 generation，不同 digest 不复用 generation，失败 build 允许留下编号空洞；因此 compiler 版本、Adapter 版本、moduleId、源码内容和 generation 结果都能由 cache identity 或恢复 metadata 验证。HMAC 密钥不得写进 loader request、cache key、stats、build metadata 或日志。

Plugin 在提交时遍历当前 compilation 模块读取 WsiBuildMetadata，不得只依赖 Loader 执行时的 registry 副作用。Webpack 5 persistent cache 或其它可证明会完整恢复 metadata 的缓存可以复用；对 `cache-loader` 等不能恢复 metadata 的层，Adapter 必须只在 Inspector development 模式禁用对应 template request 缓存。缓存命中后的 epoch/digest/build identity 无法验证时立即将本次 compilation 标错、使对应 cache entry 失效并等待下一次 rebuild；不得承诺在当前 compilation 内通过私有 API 递归重编译，也不能提交 marker 与 Manifest 不一致的结果。

增量 compilation 的暂存区从上一代成功的“模块 -> SourceRecord”映射建立 copy-on-write 基线：重新构建的模块整体替换自身记录，本次模块图已移除的模块删除记录，未重建且仍在图中的模块继承上一代记录。暂存区绑定 compiler identity、单调 buildId 和 compilation；只有最终 stats 无错误、未被后续 build supersede 且仍是当前活动 compilation 时，才在任何 success/HMR 通知前原子提交 Manifest generation。失败、取消或过期 compilation 的暂存记录全部丢弃，并继续提供上一代成功 Manifest。

Vue rule 被 `thread-loader` 包裹时，Adapter 必须在 Inspector 开发模式下让 Source Inspector Loader 在主 compiler 进程执行；不得依赖 worker 内私有全局状态。允许为定位可靠性关闭该 Vue rule 的 thread-loader，并在诊断中说明开发构建性能影响。生产配置不受影响。

首版不支持 Webpack MultiCompiler、配置数组或多个匹配 Vue compiler；doctor 返回 `MULTI_COMPILER_UNSUPPORTED` 并阻止自动启用，避免 child compiler 共用 Manifest、sessionEpoch 或 Browser Transport。

不得把 Manifest、relativePath 或源码记录序列化进浏览器 bundle。

### 10.3 Browser Transport

Runtime 依赖统一 `BrowserTransport` 接口，不直接依赖 Vite：

```ts
interface BrowserTransport {
  send(event: string, payload: unknown): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
  dispose(): void;
}
```

Vite 实现使用 HMR custom events。Webpack 子路径公开 `createWebSourceInspectorBrowserMiddleware(compiler): ConnectMiddleware | null`，它通过 compiler-instance registry 找到对应 Plugin session，并幂等返回同一 Connect middleware；无活动 development session 时返回 `null`。WDS transport 使用同源、带认证 header 的 `fetch` `POST /stream/open` 建立下行流和 `POST /message` 上行，不使用无 Origin 的 GET、redirect 或可缓存响应，不复用 webpack-dev-server 的内部 HMR websocket，也不依赖底层 HTTP server 已进入 listening：

- webpack-dev-server 3：初始化器包装 `devServer.before`，先对 `app.use()` 挂载 Inspector middleware，再按原参数和 `this` 调用用户已有 hook 恰好一次并保留其返回行为。
- webpack-dev-server >=4.7：初始化器包装 `devServer.setupMiddlewares`，先按原参数和 `this` 调用用户 hook 恰好一次，再把 Inspector middleware entry 放到其返回数组最前面；全部用户 middleware 的相对顺序和返回语义保持不变。
- 两种挂载都由 dev server 实际 HTTP 或 HTTPS server 承载，因此浏览器连接保持同源，不产生 HTTPS 页面到明文 websocket 的 mixed content；WDS 4 缺少 `setupMiddlewares` 能力时首版返回 `WDS_TRANSPORT_UNSUPPORTED`。

同源 WDS 通道仍使用随机 path、独立 browser-scoped token、loopback remote address、精确 Origin/Host/协议匹配、认证前 body 拒绝、消息大小限制、流心跳和连接容量上限；“同源”不能替代认证。通道只能执行 Browser Router 能力，不能查询路径、源码范围或 IDE token。middleware 对随机 path 之外的请求必须同步 `next()`，session 关闭时终止自身流并释放引用，不能改变 WDS HMR 或用户路由。

初始化器无法证明现有 `before`/`setupMiddlewares` 可安全包装时不得自动写入，只展示人工配置片段。WDS 版本与所用 hook 不匹配时 doctor 阻止启用。

永久写入配置的 transport wrapper 在 Plugin 未启用、mode 不是 development 或不存在活动 session 时必须严格 no-op：middleware factory 返回 `null`，WDS3 跳过 `app.use`，WDS4 跳过 Inspector entry，仅原样调用用户 hook；不生成 token，不监听端口，也不改变用户 middleware 返回值。

raw Webpack watch 使用 Plugin 启动的随机 loopback WebSocket Browser Transport。初始化配置必须给出精确 `allowedOrigins`；拒绝 wildcard、`null`、非 HTTP(S) 和未知 Origin。该通道使用独立的 browser-scoped token、随机 path、消息大小限制、心跳和连接上限，upgrade handler 只消费自身随机 path，不能复用或暴露 IDE Bridge token。对 raw Webpack 自定义 HTTPS server，首版不自动支持 loopback 降级；只有宿主显式挂载 `web-source-inspector/webpack` 提供的同源 middleware 时才声明支持，否则 doctor 返回明确的不支持诊断。

### 10.4 Vue CLI

Vue CLI 初始化通过 `chainWebpack` 在 compiler 创建前把 Source Inspector Loader 以 `.before('vue-loader')` 插入命名为 `vue` 的 rule，并加入 Webpack Plugin；现有 `chainWebpack` 为可分析的函数体时追加最小语句并保留其 `this`、参数和返回行为。若只能安全修改 `configureWebpack`，Plugin 可以在那里合并，但 Loader 顺序仍必须通过可证明的 Vue rule 配置完成；无法证明时只输出人工片段。检测到 WDS 时同时按 10.3 节包装 `devServer` hook。

不修改 `main.js`、`main.ts`、router、业务页面或 Vue 根组件。

## 11. 初始化核心

### 11.1 检测结果

`init-core` 输出结构化 ProjectProfile：

- package manager 与 workspace 根。
- Vue 版本与主版本。
- bundler 和 dev command 候选。
- Vite Vue plugin、Vue CLI、Webpack、vue-loader 和 compiler 版本。
- 配置文件路径、模块格式和 AST 可修改性。
- 推荐 Adapter、诊断和阻断原因。

所有路径对外展示为 workspace 相对路径。

### 11.2 AST 修改

支持 JavaScript、TypeScript、ESM 和 CommonJS 配置。使用 Babel parser/recast 等结构化工具读取与修改 AST，保留现有 import、export、函数、注释和大部分格式。

首版“可自动修改的标准配置”只指以下可证明形态：

- ESM `export default`、CommonJS `module.exports =`、`defineConfig(...)` 的直接对象，或同文件 local const 最终引用该对象。
- 同步/异步配置函数中唯一、可静态到达的对象返回值；允许 mode/env 参数参与其它字段，但不能有多个条件返回配置对象。
- Vite `plugins` 为数组字面量或同文件 local const 数组，且存在唯一可识别 Vue plugin 调用。
- raw Webpack 存在唯一 `.vue` rule，`loader`/`use` 为字符串、对象或数组字面量，VueLoaderPlugin 和 `plugins` 可在同文件静态定位。
- Vue CLI 的对象配置，以及函数体可分析的 `chainWebpack`/`configureWebpack`；已有 hook 只追加局部语句并保留参数、`this` 和返回值。
- WDS `devServer` 为对象或同文件 local const，目标 hook 缺失或为同文件 inline 函数。

以下形态首版明确拒绝自动写入：Webpack MultiCompiler/配置数组、从其它文件导入后再变异的配置、无法展开的 `webpack-merge`/自定义工厂、多个条件返回、computed 配置键、运行时循环生成 rules/plugins、未知 spread 决定目标数组、`eval`/动态 require，以及无法唯一识别 Vue rule/plugin 或 WDS hook 的配置。拒绝时 plan 为只读诊断和精确人工片段，不写任何文件。本节白名单是 Definition of Done 中“标准配置”的唯一含义。

Vite 计划加入：

```ts
import { webSourceInspector } from 'web-source-inspector/vite';

plugins: [webSourceInspector(), vue()]
```

Webpack/Vue CLI 计划加入：

```ts
import {
  WebSourceInspectorWebpackPlugin,
  createWebSourceInspectorBrowserMiddleware,
} from 'web-source-inspector/webpack';

plugins: [new WebSourceInspectorWebpackPlugin()]
```

实际写法随 ESM/CommonJS 和现有配置结构调整。Webpack/Vue CLI 还必须配置 10.2 节的 Vue rule Loader；只有检测到 webpack-dev-server 时才加入 `createWebSourceInspectorBrowserMiddleware` binding 和 10.3 节规定的 `devServer.before` 或 `devServer.setupMiddlewares` 包装；raw Webpack watch 加入 Plugin、Loader，并在可检测时写入精确 allowedOrigins。每一项 AST 操作都要标明目标文件、节点类型、前置结构和 `created`/`reused` 所有权结果。

### 11.3 状态与幂等

初始化成功后写入 `.web-source-inspector.json`，只记录：

- schemaVersion。
- npm package 和 Adapter 版本。
- bundler/Vue profile。
- 配置相对路径。
- 每个配置节点的目标文件、节点类型、`created` 或 `reused` 所有权以及结构化 fingerprint。

`created` 表示初始化器实际新增并可能在 remove 中撤销的节点；`reused` 表示初始化前已经存在、初始化器只复用的等价节点。`reused` 节点永远不由 remove 删除。该文件不包含 token、绝对路径或源码，可提交到版本库。再次执行 init 时先核对现有 AST 和 fingerprint，已启用则返回 no-op；节点语义相同但 fingerprint 已变化时返回冲突，不擅自重建所有权。

### 11.4 原子写入与移除

plan 为每个目标绑定 canonical workspace root、规范 workspace 相对路径、存在/缺失状态、父目录身份、`lstat` 类型、`realpath` 和可用的文件 identity；现有文件必须是 workspace 内普通非链接文件，目标及其祖先出现 symlink、Junction 或其它 reparse point 时拒绝自动修改。原内容使用 SHA-256 `beforeDigest`，不存在的新状态文件使用规范 `ABSENT` sentinel。整体 planDigest 以 `init-plan` 或 `remove-plan` operation domain、schemaVersion、规范化 ProjectProfile、全部 target identity/beforeDigest、精确 AST 操作和预期输出 digest 计算；diff 只用于展示，不作为 apply 的可信输入。

所有 plan、apply、remove 和 doctor 操作都必须在同一项目锁下先检查 pending journal。存在未完成事务时，plan 只返回 `RECOVERY_REQUIRED`，apply/remove 不开启新事务；调用方必须先运行 doctor 恢复，若 doctor 返回 `TRANSACTION_CONFLICT` 则禁止任何新写入。

apply 必须接收用户刚确认的 init planDigest。写入前获取项目级初始化锁，重新验证 root/target identity、重新检测项目、重新解析全部文件并重新生成计划；任一存在性、identity、beforeDigest 或整体 planDigest 与已确认计划不一致时返回稳定错误码 `PLAN_STALE`，不写任何目标文件，要求重新预览确认。每次原子替换前还要重新核对 target identity 和 digest；若前面文件已写而后续文件变 stale，则进入同一事务回滚，不能保留半完成配置。

apply 在写入前完成全部 parse 和 plan 校验。每个文件只在已重新验证的同目录中以独占方式创建随机临时文件并原子替换；多文件操作使用事务 journal、原内容快照和失败回滚。临时文件流程固定为：持久化事务 ID/root-relative tempName，独占创建 temp，立即 lstat 并持久化 tempIdentity，再写入并 flush 内容，持久化 afterDigest/rename intent，最后 rename；同卷原子 rename 必须保留该 identity，rename 后再复核。journal 记录 schema、canonical root identity、root-relative target/tempName、阶段、beforeIdentity/tempIdentity/afterIdentity 和 before/after digest，不记录源码。快照放在当前用户私有 runtime 目录，使用受限权限/ACL，不写日志或版本库，成功或回滚后立即清理。

多文件系统操作不宣称具有数据库式原子性。doctor 的崩溃恢复必须获取同一项目锁，重新验证 journal schema、canonical root 和每个 root-relative target/tempName；只有 current 是普通非链接文件、`currentDigest === transaction.afterDigest` 且 `currentIdentity === transaction.afterIdentity` 时才自动恢复：若 before 为普通文件则写回 before snapshot，若 before 为 `ABSENT` 则安全删除该普通文件且不要求 snapshot。rename 前遗留的 temp 只有在登记的 tempName、普通非链接类型和 tempIdentity 全部匹配时才删除。当前已等于 beforeDigest/`ABSENT` 视为已恢复，其它状态只报告 `TRANSACTION_CONFLICT` 而不覆盖。journal 路径越界、canonical root/after identity 变化、snapshot 校验失败或 target/temp 被换成链接时一律拒绝自动恢复。

remove 使用用户刚确认、以 `remove-plan` domain 生成的独立 removePlanDigest，以及相同的重新生成计划和 `PLAN_STALE` 保护；init planDigest 绝不能授权 remove。它在锁内先完整预检所有 fingerprint、共享引用、状态文件和 target identity，再开始事务写入。remove 只能删除所有权为 `created` 且当前结构化 fingerprint 仍完全匹配的 import/require、插件实例、Loader 和 transport hook；`reused` 节点、被用户修改的节点、或新增了其它引用的共享 import/require 均不得删除。只有全部 AST 移除成功或确认无需移除后，才把初始化器拥有且未被修改的状态文件纳入同一事务删除。

### 11.5 Extension 调用

Extension 只在本地受信任 workspace 中启用项目修改能力。它从 workspace `node_modules` 解析项目安装的 `web-source-inspector`，以参数数组启动项目 CLI；Enable/View Plan、apply、doctor 和 remove 全部调用该 CLI 的版本化 JSON API，并用 IDE diff 展示 plan/remove plan。Extension 不复制 ProjectProfile 检测、AST 修改、fingerprint 或事务逻辑。

JSON API 固定为：

| 操作 | 参数 |
| --- | --- |
| init plan | `init --json --phase plan [--answer <id>=<value>...]` |
| init apply | `init --json --phase apply --plan-digest <digest> [--answer <id>=<value>...]` |
| doctor | `doctor --json` |
| remove plan | `remove --json --phase plan` |
| remove apply | `remove --json --phase apply --plan-digest <removePlanDigest>` |

JSON 模式不显示 prompt、颜色或进度条；stdout 只输出一个 UTF-8、版本化 envelope，包含 schema/protocol、operation、ok、result、diagnostics 和稳定 errorCode，普通日志只写脱敏 stderr。退出码区分成功/no-op、可预期的阻断/冲突和内部/IO 错误。交互式 `init`/`remove` 只是同一 plan/apply API 的薄封装：渲染 diff、取得确认、回传刚确认的 digest，不另写检测或修改逻辑。

plan 需要用户决策时在 result 中返回稳定 questionId、类型、候选和校验约束；调用方用重复的 `--answer <questionId>=<value>` 参数重新请求 plan。最终 plan 同时返回规范化 normalizedAnswers。CLI 与 Extension 均不得自己解释答案对 AST 的影响，所有答案由 init-core 校验并纳入 planDigest；未知、重复或过长答案直接拒绝。

init apply 是独立进程时必须回传最终 plan 的同一组 normalizedAnswers，init-core 用它们重新生成计划后再比较 planDigest；缺失返回 `PLAN_CONTEXT_REQUIRED`，答案变化则返回 `PLAN_STALE`。planDigest 不是可反解的状态存储，不能只传 digest 后猜测用户先前选择。

Extension 不执行 shell 字符串拼接，不使用全局 npm 包，不从 workspace 外加载初始化器。init apply 必须回传用户刚确认的 init planDigest 和 normalizedAnswers，remove apply 回传 removePlanDigest；并原样处理 `PLAN_STALE` 后重新打开预览。扩展与项目 npm 包 protocol major 不兼容时，阻止 apply 并提示升级。

## 12. Dev Session 与 IDE 打开

`dev-session-core` 复用现有安全模型：

- IDE Bridge 只监听 `127.0.0.1` 随机端口。
- Authorization bearer token、随机 path 和固定 websocket subprotocol。
- session descriptor 原子写入、心跳、PID 校验、陈旧清理和关闭屏障。
- Browser page、dev server、IDE client 和 open request 一对一关联。
- 多 tab、多 dev server、多 IDE 不广播打开。
- sourceId 只在当前 session 有效，HMR 旧 ID 只返回 stale。
- 所有消息使用中央 runtime validator、UTF-8 byte limit、容量和 TTL 上限。

Extension 收到打开请求后再次验证：

- workspace 已受信任且不是 Remote。
- rootKey 与当前 workspace 匹配。
- relativePath 是规范 wire path。
- `realpath + path.relative` 确认普通文件同时位于 session root 和 workspace root 内。
- 拒绝绝对路径、URI、UNC、设备路径、控制字符、symlink/Junction 逃逸和目录。
- 未保存内容只在 source context 唯一匹配时调整范围。

## 13. 运行时状态与降级

Browser Runtime 状态：

```text
disabled -> armed -> opening -> disabled/armed
```

- Inspector UI 在 Shadow DOM 中渲染，不成为命中目标。
- armed/opening 状态在 capture 阶段阻止业务 pointer、mouse、touch、click、contextmenu 和 drag 事件。
- pointermove 每动画帧最多处理一次，不扫描整棵 DOM。
- 每次 selection 带 requestId，只处理当前 pending 结果。
- `Esc`、HMR dispose、unload 和 disable 完整解绑。

错误提示使用稳定错误码和可操作中文文案：

| 场景 | 行为 |
| --- | --- |
| npm 包未安装 | Extension 展示准确安装命令 |
| 已安装未启用 | 展示 Enable Project |
| 配置歧义 | 展示候选并要求选择 |
| 配置无法安全修改 | 不写文件，展示人工片段 |
| dev server 未启动 | 状态栏显示等待项目启动 |
| IDE 未连接 | Browser 显示未连接 |
| 多 IDE 未 claim | 要求选择 IDE |
| sourceId stale | 提示刷新/重试，不打开文件 |
| 无可信候选 | 显示不支持，不猜测位置 |

## 14. 首发兼容矩阵

| 维度 | 支持范围 |
| --- | --- |
| Vue | 2.6、2.7、3.2+ |
| Vite | 2～6 |
| Webpack | 4、5 |
| Vue CLI | 3、4、5 |
| vue-loader | 15、16、17 |
| Script | JavaScript、TypeScript、Options API、Composition API；`script setup` 按消费项目 Vue/toolchain 本身支持范围 |
| Template | `.vue` 内普通 HTML template |
| Node.js | npm 工具链最低 Node 16；消费 bundler 的更高要求优先 |
| IDE | VS Code 1.90+、兼容版本 Cursor，本地 Extension Host |

版本支持必须由 fixture 和真实运行证据声明。peer dependency 范围不能代替兼容测试。

版本维度不是无条件笛卡尔积，只声明上游 Vue toolchain 本身兼容且 doctor 校验通过的组合族：Vue 2.6 + `vite-plugin-vue2` + Vite 2；Vue 2.7 + `@vitejs/plugin-vue2` + 其 peer range 内 Vite；Vue 3.2+ + `@vitejs/plugin-vue` + Vite 2～6；Vue 2.6/2.7 + vue-loader 15 + Webpack 4/5；Vue 3.2+ + vue-loader 16/17 + Webpack 4/5。Vue CLI 只声明其各主版本能够实际安装的 Vue/Webpack/vue-loader/WDS tuple，发布文档必须列出已验证组合，不能把单维版本表解释成任意交叉组合。

## 15. 性能要求

- 不为每个 DOM 节点注册事件。
- 不使用全局 MutationObserver 扫描页面。
- pointermove 每动画帧最多计算一次。
- SFC 解析可按“内容 + Vue compiler + Adapter 配置版本”缓存；包含 sourceId 的最终 transform 结果还必须绑定当前 sessionEpoch，不能跨开发会话复用。
- HMR 只替换变化模块 Manifest。
- Manifest、tombstone、message replay、pending request、连接和初始化 plan 都有容量或 TTL 上限。
- Webpack 中为可靠性关闭 Vue rule thread-loader 时，必须只影响 development Inspector 模式并记录基准。
- Inspector 未启用时，Adapter 对现有开发构建没有运行时副作用。

## 16. 安全与隐私

- 初始化修改必须 plan-first、用户确认、原子写和可移除。
- `postinstall` 不修改项目，不执行隐式网络请求。
- Browser 不发送路径、源码、命令或 IDE token。
- IDE Bridge token 不进入 DOM、URL、普通日志或 workspace 文件。
- Browser channel 与 IDE Bridge 使用不同凭据和能力。
- 默认日志只记录诊断码、版本和相对路径，并脱敏用户目录。
- Extension 不允许打开 workspace 外文件。
- Adapter 只在真实开发服务生命周期启动控制链路；Webpack 额外要求最终 `compiler.options.mode === 'development'`，Vite 以 `configureServer` serve 生命周期为准而非 mode 字符串。
- HMAC key、browser token 和 IDE token 独立生成且能力隔离，token 使用恒定时间比较。
- 生产扫描必须覆盖 WSI marker、WSI virtual module/runtime bootstrap、`wsi:` Browser 事件、`/wsi/` transport/Bridge 路径、测试捕获的实际 session token，以及 workspace 绝对路径；不得用泛词 `Runtime`、`Bridge`、`token` 误报业务代码。
- npm 包、VSIX 和第三方许可证 notice 在每个发布候选重新核验。

## 17. 测试与验收

### 17.1 初始化器

覆盖：

- npm、pnpm、yarn 项目标识。
- Vite/Vue CLI/raw Webpack 检测。
- Vue 2/3、Webpack 4/5、vue-loader 15/16/17 组合。
- JS/TS、ESM/CommonJS 配置。
- 对象配置、defineConfig、函数配置和 Vue CLI configureWebpack。
- plan 与 Extension plan 输出一致。
- plan/apply 之间修改任一目标文件时返回 `PLAN_STALE` 且不写文件。
- 同内容文件替换、目标存在性变化、symlink/Junction/reparse point 和父目录 identity 变化均阻断写入。
- init 幂等。
- `created`/`reused` 所有权准确，remove 只删除 fingerprint 未变化的 `created` AST 节点。
- WDS 3/4 hook 包装保留原 hook 的参数、`this`、middleware 顺序和返回值，并可幂等执行。
- 多文件写入失败完整回滚。
- 崩溃 journal 只在 currentDigest 等于本事务 afterDigest 时恢复；外部修改返回 `TRANSACTION_CONFLICT`。
- 复杂/动态配置明确拒绝自动写入。

### 17.2 Transform

跨 Vue 2/3 的公共用例覆盖：

- 普通/嵌套/自闭合/SVG 标签。
- 多行属性、指令、事件、ref、key。
- `v-for`、条件、Slot、动态组件。
- 自定义组件与第三方组件调用点。
- script JS/TS、Options API、Composition API、无 script；transform 不读取 script 业务语义。
- LF/CRLF、BOM、中文/空格路径、emoji、tab。
- 在同一 sessionEpoch、module digest/generation 内 sourceId 稳定；新 session 必须轮换，另覆盖碰撞、generation、stale 和删除。
- Webpack 成功/失败 rebuild、增量模块继承和跨进程持久缓存失效。
- 失败 build 后由其它文件触发成功 rebuild 时，cache hit/metadata replay 仍保证 DOM marker 与 Manifest sourceId 一致。
- Vite WSI pre-transform 成功但下游 Vue plugin 失败时，Manifest 仍保留上一代，修复后再提交新 generation。
- sourcemap 回到原始 SFC；WSI 新增的 map/source 内容不得包含绝对路径，Browser 协议/runtime 仍不下发 relativePath、range 或源码上下文。
- template lang 不支持诊断和 marker 属性冲突。

版本专属用例拆分为：

- Vue 2.6：单根 template、Vue 2 slot/scoped-slot 语法、Options API，以及安装 `@vue/composition-api` 的 Composition API fixture；不要求 Fragment、多根、Teleport 或 `script setup`。
- Vue 2.7：单根 template、内置 Composition API、Vue 2.7 支持的 `script setup` 和其 compiler 行为；不要求 Fragment、多根或 Teleport。
- Vue 3.2+：Fragment/多根、Teleport、Vue 3 slot、Composition API 和 `script setup`。

任何版本专属能力只在对应 fixture 中验收，不能用 Vue 3 特性失败推翻 Vue 2 Adapter 的公共定位能力。

### 17.3 Bundler fixture

至少维护以下明确组合，锁定 fixture 的 Vue、bundler、Vue plugin/vue-loader 和 WDS 主版本：

- Vue 2.6 + Vite 2 + `vite-plugin-vue2` 2.x。
- Vue 2.7 + Vite 3 + `@vitejs/plugin-vue2` 2.x。
- Vue 3.2 + Vite 2 + `@vitejs/plugin-vue` 2.x。
- Vue 3.3 + Vite 4 + `@vitejs/plugin-vue` 4.x。
- Vue 3.4 + Vite 5 + `@vitejs/plugin-vue` 5.x。
- Vue 3.5 + Vite 6 + `@vitejs/plugin-vue` 5.2.x。
- Vue 2.6 + Vue CLI 3 + Webpack 4 + vue-loader 15 + WDS 3.x。
- Vue 2.6 + Vue CLI 4 + Webpack 4 + vue-loader 15 + WDS 3.x。
- Vue 3.2 + Vue CLI 5 + Webpack 5 + vue-loader 17 + WDS 4.7+。
- Vue 2.6 + raw Webpack 4 + vue-loader 15 + watch loopback transport。
- Vue 2.7 + raw Webpack 5 + vue-loader 15 + watch loopback transport。
- Vue 3.2 + raw Webpack 4 + vue-loader 16 + watch loopback transport。
- Vue 3.2 + raw Webpack 5 + vue-loader 16 + watch loopback transport。
- Vue 3.5 + Webpack 5 + vue-loader 17 + WDS 4.7+ 同源 transport（非 Vue CLI）。

版本区间的上下边界应在 CI 矩阵中验证，不能只维护单一当前版本。上述组合分别覆盖 Vue CLI 3/4/5、vue-loader 16/17、WDS 3/4 和 raw Webpack 4/5，不允许用一个近似组合代替另一个声明维度。

每个 vue-loader 15/16/17 fixture 必须检查实际 template request loader chain、最终 render 代码或浏览器 DOM marker，以及 server-side SourceRecord；只观察 Source Inspector Loader 在 raw SFC 请求中被调用不能作为成功证据。缓存矩阵至少覆盖 Webpack 5 filesystem cache，并在存在 `cache-loader` 的 Vue CLI/Webpack 4 fixture 中验证禁用或 metadata 恢复策略。

### 17.4 Browser 与 IDE E2E

每类 Adapter 至少验证以下公共流程：

- 初始化后原开发命令可启动。
- Inspector 出现且连接状态准确。
- 普通元素打开正确 `.vue` 和 template 行列。
- `v-for`、条件、Slot 和组件调用点。
- Element Plus、Element UI 或该 Vue 版本的等效第三方组件只打开用户代码。
- 选择模式不触发链接、提交、删除、拖拽和页面级 pointer handler。
- `Esc`/disable 后业务行为恢复。
- HMR 新位置正确，旧 sourceId stale。
- 多 tab、多 server、多 IDE 不串线。
- Vite、WDS 和 raw transport 均拒绝错误 browser token、错误 Origin、socket/page 复用和超限消息。
- untrusted workspace 不连接或打开。
- VS Code 与 Cursor 安装最终 VSIX 后完成真实跳转。

Vue 2.7 与 Vue 3 Adapter 验证各自 toolchain 的 `script setup`；Vue 3 另外验证 Fragment/多根和 Teleport。Vue 2.6 使用 17.2 节的专属语法，不要求执行这些场景。

### 17.5 生产与发布

- 所有 fixture production build 成功。
- 产物搜索不到 `data-wsi-source`、`data-wsi-component-source`、WSI virtual module/runtime bootstrap、`wsi:` Browser event、`/wsi/` transport/Bridge path、测试捕获的实际 token 或 workspace 绝对路径。
- Webpack `mode` 缺失、`mode: 'production'`、以及 production + watch/devServer 组合均 fail-closed，不创建 marker、Runtime、Manifest、Browser Transport、IDE Bridge 或 session descriptor。
- production 下已写入配置的 WDS transport wrapper 保持严格 no-op，用户原有 hook 行为与返回值不变。
- production 验收同时断言没有 loader transform、rule/entry/cache 运行时改写、随机密钥/token、监听端口、session descriptor、已挂载的 Inspector middleware、可响应 endpoint、stream/connection 或监听资源；允许静态 wrapper 存在但其 middleware factory 返回 null，不能只搜索最终 bundle。
- Vite 验证 `serve --mode production` 按 serve 启用、`build --mode development` 按 build 禁用；Webpack 仍只认最终 `compiler.options.mode === 'development'`。
- Vite `preview` 验收无 marker、Runtime、Manifest、Bridge、token、监听器和 session descriptor。
- 唯一公开的 `web-source-inspector` npm tarball 只包含 `package.json`、声明文件、运行代码、README、LICENSE 和必要 notice；内部 workspace package 均为 private 且不出现在发布清单。
- VSIX 不包含源码、测试、sourcemap、fixture、token 或无关依赖。
- 使用真实 Node 16.20.2 分别执行 CLI JSON `doctor/plan`、CommonJS `require('web-source-inspector/vite')`、ESM `import('web-source-inspector/vite')`、CommonJS `require('web-source-inspector/webpack')` 和 ESM `import('web-source-inspector/webpack')`；Vite 6 等项目按自身更高 Node 要求单独验证。

## 18. 实施阶段

各阶段按顺序实施，首个通用公开版本必须完成全部阶段。

### 阶段 A：公共核心与 Adapter 合同

- 从现有 Vite 插件提取 bundler-neutral dev-session-core。
- 拆分 Vue 2/Vue 3 transform 合同。
- Runtime 引入 BrowserTransport 接口。
- 保持现有 Vue 3 + Vite fixture 全部通过。

### 阶段 B：统一 npm 包与 init-core

- 新建对外 `web-source-inspector` package 和 bin。
- 实现 detect、plan、apply、doctor、remove。
- 支持 Vite、Vue CLI 和 raw Webpack 配置 AST。
- 建立 `.web-source-inspector.json` schema。

### 阶段 C：Vite Vue 2/3

- 将现有 Vue 3 Vite 能力迁移到 Adapter。
- 实现 Vue 2 compiler 和 Vite plugin 兼容层。
- 完成 Vite 2～6 fixture 矩阵。

### 阶段 D：Webpack/Vue CLI Vue 2/3

- 实现 Webpack Plugin、Loader、record registry 和 Runtime entry 注入。
- 实现 WDS 3 `before`、WDS 4 `setupMiddlewares` 同源 transport 和 raw watch loopback transport。
- 覆盖 Webpack 4/5、Vue CLI 3/4/5 和 vue-loader 15/16/17。

### 阶段 E：Extension 项目管理

- Enable/View Plan/Doctor/Disable 命令和状态栏状态。
- 调用 workspace 本地 npm 包 JSON plan API。
- Diff 预览、确认、版本兼容和失败提示。

### 阶段 F：矩阵验收与发布

- 完成所有 fixture、Browser E2E、Extension E2E 和安全测试。
- 真实安装最终 VSIX 到 VS Code 与 Cursor。
- 核验 npm tarball、VSIX、生产产物和 notice。
- 发布兼容矩阵、快速开始、故障排查和迁移说明。

## 19. 主要风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| Vue 2 compiler 与 Vue 版本不一致 | AST 坐标或编译失败 | 从项目解析并严格校验版本，doctor 阻断 |
| Webpack rule 结构差异大 | Loader 插入顺序错误 | 结构化 rule 检测、唯一性要求、复杂配置转人工 |
| thread-loader 隔离 registry | Manifest 丢失 | Inspector dev 模式让 WSI Loader 在主进程执行 |
| 多 entry/runtime 重复 | 多个按钮或连接 | Webpack entry 注入 + global singleton guard |
| WDS 版本和 HTTPS transport 差异 | Browser 无法连接 | transport 能力检测；不安全 mixed-content 不降级 |
| AST 修改破坏用户配置 | 项目无法启动 | plan/diff/confirm、逐文件原子替换、事务 journal、fingerprint 和 remove |
| 扩展与 npm 包版本漂移 | 初始化或协议不兼容 | protocol major 检查、capability 协商和升级提示 |
| 兼容矩阵组合爆炸 | 回归遗漏 | 代表 fixture + 上下边界 CI + contract tests |
| 第三方组件 marker 不透传 | 无精确 DOM marker | Vue owner/组件调用点候选，不进入 node_modules |

## 20. Definition of Done

通用版本只有同时满足以下条件才可称为完成：

- 用户只安装一个 VSIX 和一个 npm 包。
- CLI init 与 Extension Enable Project 使用相同初始化核心并产生相同 plan。
- 所有声明支持的标准 Vite、Vue CLI 和 Webpack 配置形态均无需用户手工编辑；超出支持语法的复杂动态配置必须安全拒绝并明确标记为未自动适配。
- Vue 2/3、Vite、Webpack 4/5、Vue CLI 3/4/5 的声明 fixture 全部通过。
- JS/TS SFC 点击均打开正确 `.vue` template 标签。
- 第三方组件只定位用户调用点。
- init 幂等，remove 不破坏用户配置。
- dev server、Browser、Bridge 和 IDE 生命周期可清理且不会串线。
- 路径、token、消息和生产构建安全要求通过。
- 最终 VSIX 在 VS Code 和 Cursor 中真实安装并完成端到端点击跳转。
- npm tarball、VSIX、文档、兼容矩阵、LICENSE 和 NOTICE 可用于本地发布候选。

## 21. 已确认决策

- 必须同时支持 Vite 与 Vue CLI/Webpack，不能只做 Vite 后发布。
- 对外一个 npm 包，内部使用 Adapter 架构。
- CLI init 与 Extension 点击启用两个入口同时提供。
- 不追求安装后静默生效；采用一次明确确认，后续零手工配置。
- 首版只定位 `.vue` HTML template，不做纯 JS DOM、JSX/TSX 或 render 函数。
- 首要定位标准是正确 `.vue` 文件和正确 template 标签。
- 现有仓库继续演进，当前 Vue 3/Vite 实现作为基线。
