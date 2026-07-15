# 能力与验证矩阵

本文以 `0.1.0-beta.3` 为公开基线，描述代码语义和验证范围。正式接入要求目标项目本地安装 `web-source-inspector` 开发依赖；VS Code/Cursor 扩展只调用该工作区内的 CLI，预览计划和 diff 后由用户确认写入配置。扩展不会安装 npm 包，也不支持仅安装插件、零项目接入。初始化只修改受支持的构建配置，不修改业务源码，且 Inspector 不进入生产构建。能力已实现、仓库存在自动化用例、最近一次用例通过、真实 VSIX 安装通过是四件不同的事情；没有对应证据时统一标记为“未验证”。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| 精确 | 设计目标是打开原始模板节点的完整文件范围。 |
| 近似 | 打开可信的用户代码候选，例如第三方组件调用点。 |
| 有限 | 只覆盖列出的版本、fixture 或边界。 |
| 不支持 | 当前不会生成可靠候选，UI 应明确降级。 |
| 待验证 | 代码或 fixture 已存在，但没有对应的真实端到端证据。 |

## 兼容性判定

可安装的 peer 范围为 Vue 2.6（>=2.6.0 <2.7.0）、Vue 2.7（>=2.7.0 <2.8.0）和 Vue 3（>=3.2.0 <4.0.0），Vite >=2.9.0 <7.0.0、Webpack >=4 <6、Vue CLI 3-5。运行期只接受实际 Vue plugin 或 loader、compiler、Webpack Dev Server 与 transport 共同满足上游 peer 规则的 tuple。官方 `vue-loader` 15/16/17 不声明 Vue peer；Vue family 由实际 `vue/package.json` 完整版本判定。Webpack/Vue CLI 路径再校验 vue-loader 主版本是否与该 Vue family 匹配，并校验其 Webpack peer；Vite 路径不依赖 vue-loader。compiler 证据按 family 校验：Vue 2.6 的 `vue-template-compiler` 必须与实际 Vue 完整版本一致；Vue 2.7 必须从实际 `vue` package anchor 解析 `vue/compiler-sfc`；Vue 3 的 `@vue/compiler-sfc` 和 `@vue/compiler-dom` 都必须存在，且分别与实际 Vue 完整版本一致。包管理器合同支持 npm、pnpm 及 node_modules 模式的 Yarn；Bun 和 Yarn PnP 会由 detect/doctor 拒绝。该合同与真实 fixture/E2E 证据分开列示。raw Webpack watch 还要求精确 HTTP Origin，HTTPS Origin 会返回 `RAW_WATCH_HTTPS_UNSUPPORTED`。可安装 peer 范围不等于任意运行期 tuple 兼容，更不等于已完成真实验证。

## 当前自动化基线

根 Vite Playwright 配置启动 `fixtures/vue-vite-basic`，定义 7 项用例：

1. 开发页注入 Inspector 按钮和源码 marker。
2. 操作 Inspector 按钮不会触发页面级 pointer 监听。
3. `v-for` 多实例共享同一个模板 sourceId。
4. Teleport 到独立容器后仍保留 marker。
5. Shift 命中 `inheritAttrs: false` 多根组件时选择调用方 marker。
6. 选择模式阻止业务点击，`Esc` 退出后恢复。
7. tooltip 不展示路径或行列，Browser 协议中也不包含这些字段。

独立 Webpack Playwright 配置启动 `fixtures/vue-webpack-basic`，定义 1 项真实链路用例，覆盖 43 字符 marker、业务点击、Inspector UI、WDS stream/hello 和 metadata request。已留存的基线结果为 Vite `7/7`、Webpack `1/1`。Element Plus 和 monorepo fixture 尚未接入 Playwright 流程。

Extension Host E2E 使用 `extensionDevelopmentPath`，默认目标为 VS Code 1.110，并覆盖 trusted/untrusted 激活、命令注册和直接调用 `SourceOpener`。它不安装打包后的 VSIX，也不建立 Browser -> Vite -> Bridge -> Extension 的完整链路。

已留存的 `0.1.0-beta.2` 基线还包括 15 个 workspace 项目的类型检查、35 个测试文件共 `244/244` 项单元/集成测试、完整 workspace 构建，以及最终 tgz 在 Node.js `16.20.2` 下安装后的根/Vite/Webpack CJS/ESM、物理 Loader 和 CLI doctor smoke。Vite basic 与 Webpack basic 分别执行生产构建后，Inspector marker/Runtime/Bridge 特征和 workspace 绝对路径扫描均为 0。打包 VSIX 已在 Cursor 中安装，并在真实 Vue CLI 3 项目中自动连接 Bridge；浏览器点击到实际文件打开仍需单独验收。

## DOM 与 Vue

| 场景 | 当前行为 | 定位等级 | 自动化/证据状态 |
| --- | --- | --- | --- |
| 普通 Vue 原生元素 | 注入 `data-wsi-source`，记录完整 SFC 范围 | 精确 | transform 单元覆盖；basic E2E 覆盖 marker，不等同真实 IDE 打开 |
| 文本节点 | 由承载文本的模板元素提供位置 | 精确到宿主 | transform 语义存在；真实 IDE 未验证 |
| `v-for` | 运行时实例共享模板 sourceId，并保留控制流候选 | 精确 | basic E2E 覆盖共享 ID；Alt 控制流打开未做真实 E2E |
| `v-if / v-else-if / v-else` | 为当前分支生成记录和控制流信息 | 精确 | transform 单元覆盖；浏览器/IDE E2E 未验证 |
| Slot | slot 内容按实际声明模板记录，虚拟 slot 可作为候选 | 精确或有限 | transform 单元覆盖；浏览器/IDE E2E 未验证 |
| Fragment/多根组件 | 实际根节点保留 marker，另有虚拟 Fragment 记录 | 精确或有限 | transform 单元覆盖；真实 IDE 未验证 |
| Teleport | marker 随实际 DOM 输出到目标容器 | 精确 | basic E2E 覆盖 marker；真实 IDE 未验证 |
| 项目内组件 | 普通点击偏向实际 DOM，Shift 偏向组件调用点 | 精确/调用点 | DOM 单元覆盖；basic E2E 覆盖 `inheritAttrs: false` Shift 调用点 |
| 动态组件 | 内部 DOM marker 优先，否则到 `<component :is>` 调用点 | 近似 | transform 单元覆盖；真实 E2E 未验证 |
| Element Plus/第三方组件 | 默认不转换依赖源码，回到用户调用点 | 近似 | fixture 已存在；当前根 E2E 未覆盖 |
| `v-html` / `innerHTML` | 只能定位容器或赋值来源 | 近似/不支持内部节点 | 未形成完整 adapter 与 E2E |
| 外部 `<template src>` | 返回明确诊断，不转换 | 不支持 | transform 单元语义 |
| Pug、MDX 等非 HTML template | 返回明确诊断，不转换 | 不支持 | transform 单元语义 |

## 浏览器、Bridge 与 IDE

| 能力 | 当前状态 | 证据边界 |
| --- | --- | --- |
| Shadow DOM Inspector 与 hover | 已实现 | basic E2E 覆盖入口、pointer 隔离和 tooltip；高 z-index 真实业务页面待验证 |
| 选择模式业务事件隔离 | 已实现 | basic E2E 覆盖 click 和 Inspector pointer；拖拽、Three controls、表单提交等真实场景待验证 |
| HMR generation 与 stale tombstone | 已实现 | Manifest/Router 单元覆盖；真实 HMR 浏览器链路待验证 |
| 多 browser tab 结果路由 | 已实现 | Router/Bridge 单元覆盖；完整浏览器 E2E 待验证 |
| 多 IDE claim/focus 路由 | 已实现 | WebSocket 单元覆盖；VS Code + Cursor 同时连接待验证 |
| Workspace Trust | 已实现 | Extension Host trusted/untrusted 场景；真实 VSIX 待验证 |
| realpath、symlink/Junction containment | 已实现 | 路径单元覆盖；各平台真实文件系统 smoke 仍需发布证据 |
| 未保存内容上下文校正 | 已实现 | SourceOpener/relocation 单元或 Extension Host 直接调用；完整 Bridge E2E 待验证 |
| VS Code 1.90 | manifest 最低版本为 `^1.90.0` | 真实 VSIX 安装未验证 |
| 当前 VS Code | Extension Host 默认下载/使用 1.110 | 仅开发扩展路径；真实 VSIX smoke 未验证 |
| Cursor | 使用稳定 VS Code API 并识别 appName | 打包 VSIX 已安装，且已自动连接 `xuanwu-ui-2.0` 的本机 Bridge；浏览器点击后打开和 reveal 实际 `.vue` 文件仍待验收 |

## 构建工具与运行环境

| 环境 | 状态 | 说明 |
| --- | --- | --- |
| Vue 3.5 + Vite 6 | 有限支持 | `vue-vite-basic` 已有 7 项 Browser E2E 证据；真实 VSIX 打开源码仍待验证 |
| Vue 2.6/2.7 + Vite 2/3 | 待验证 | compiler 解析与 adapter 分流已实现，尚未完成计划中的真实版本 fixture 矩阵 |
| Vue 3.2～3.4 + Vite 2～5 | 待验证 | peer/实现范围已覆盖，尚不能用范围声明代替逐 tuple 验证 |
| Vue 3.5.39 + Webpack 5.108.4 + vue-loader 17.4.2 + WDS 4.15.2 | 有限支持 | `vue-webpack-basic` Browser E2E 覆盖 Loader、Runtime、WDS 和 metadata；真实 IDE 打开仍待验证 |
| Node.js 16.20.2 发布包 | 有限支持 | 最终 tgz 隔离安装后的根/Vite/Webpack CJS/ESM、物理 Loader 和 CLI doctor 已通过；Vite 6 fixture 按其上游要求使用更高 Node |
| Vite/Webpack basic 生产产物 | 有限支持 | 两类 fixture 的生产构建均通过，Inspector 特征和 workspace 绝对路径扫描为 0；真实消费项目仍待验证 |
| Vite build、preview、`enabled: false` | 已实现 no-op | 这些场景不创建 Inspector session 或注入开发态能力；生产消费项目仍应扫描实际产物 |
| Webpack 非 `development` 模式 | 已实现 no-op | 不进入 Runtime、marker、Bridge 或 Manifest 注入路径 |
| Webpack raw watch | 有限支持 | 仅接受精确 HTTP Origin；HTTPS Origin 返回 `RAW_WATCH_HTTPS_UNSUPPORTED` |
| Vue 2.7.16 + Vue CLI 3.12.1 + Webpack 4.47.0 + vue-loader 15.11.1 | 有限支持 | 已在 `xuanwu-ui-2.0` 完成空缓存启动和不清缓存重启；WDS3 hook 使用 `before(app, server)` 与 `server.compiler`，消息端点已挂载，Session descriptor 已生成，Cursor 已连接 Bridge；浏览器点击后打开实际 `.vue` 文件仍待验收 |
| Webpack 4 / vue-loader 16 | 待验证 | Adapter 单元与公开 bundle smoke 覆盖版本 fallback 和 registry；真实版本 loader chain 与浏览器 fixture 尚未验证 |
| Vue CLI 4/5 | 待验证 | init-core 能生成标准配置计划；真实 Vue CLI fixture 和浏览器链路尚未完成 |
| pnpm monorepo 源码包 | 待验证 | workspaceRoot/sourceRoots 实现和 fixture 已存在，根 E2E 尚未覆盖 |
| npm、pnpm、Yarn（node_modules 模式） | 支持合同 | detect/doctor 接受；真实 fixture/E2E 证据仍待单独验证 |
| Bun、Yarn PnP | 不支持 | detect/doctor 明确拒绝 |
| SSR/hydration | 不支持声明 | 尚无服务端/客户端一致注入验证 |
| Rollup 独立 adapter | 不支持 | 当前没有独立 Rollup 接入；Vite 只覆盖其自身开发服务器链路 |
| React/Svelte | 不支持 | 没有 transform adapter |
| Three.js/Canvas 对象 | 不支持 | 只可定位 canvas DOM；对象级来源需要独立 adapter |
| 本机 loopback | 支持目标 | Dev Server、Extension Host 和源码必须在同一机器 |
| Vite 同机网卡 IP | 有限支持 | `browserAccess` 默认 `same-machine`，只接受回环或启动快照中的本机地址，且不改写 `server.host`；`0.1.0-beta.1` 的默认 loopback fixture 拒绝记录保留为历史证据，消费项目 Vite 6.4.1 的 localhost/127.0.0.1/192.168.8.155 Runtime、Cursor 回执和生产扫描通过，另一设备拒绝未实测 |
| Remote SSH/WSL/Docker/Dev Container/Codespaces | 不支持 | 临时目录、loopback 和文件系统边界尚未设计验证 |
| 其它设备浏览器 | 不支持 | `same-machine` 不信任子网、代理、端口转发或远程设备；`remoteBrowser` 已弃用且只允许 `false` |

## 发布前必须补齐

- 打包 VSIX 仍需在 VS Code 1.90 和当前 VS Code 中完成安装 smoke，并在 Cursor 中补齐浏览器点击到文件打开/reveal 的最终交互。
- 通过真实 Bridge 从 basic fixture 打开正确 URI、selection 和 reveal。
- 把 Element Plus 与 monorepo fixture 接入可重复的浏览器/IDE 验证。
- 覆盖 HMR stale、多 tab、多 IDE、拖拽/表单/Three 事件副作用。
- 对真实消费项目生产构建执行 Runtime、marker、Bridge 和绝对路径字符串扫描。
- 每次分发内容变化后重新检查 npm tarball、VSIX 和第三方许可证通知；已留存基线的 24 项 tgz 与 7 项 VSIX 白名单已检查。

发布证据模板见 [release.md](release.md#证据记录模板)。
