# 架构与关键决策

## 目标

Web Source Inspector 在开发态把浏览器中的 Vue DOM 节点映射回可信的 workspace 源码范围。精确定位依赖项目端编译信息，不能只靠 IDE 扩展或浏览器最终 DOM 推断。

正式接入先由目标项目本地安装 `web-source-inspector` 开发依赖，再由 CLI 或 VS Code/Cursor 扩展生成接入计划。扩展只以参数数组调用工作区内的 CLI，展示计划和 diff 后等待用户确认；它不安装 npm 包、不使用全局 CLI，也没有仅安装插件、零项目接入的实现路径。初始化只修改受支持的构建配置，不修改业务源码。

架构遵守四个不变量：

1. 浏览器只持有不透明 `sourceId`、Browser Transport 专用 token 和必要会话元数据，不接收源码路径、源码范围或 IDE Bridge token。
2. 只有当前 Dev Server 进程中的内存 Manifest 能把 `sourceId` 解析为源码记录。
3. IDE Bridge 只接受本机 loopback 连接并使用随机 token 认证。
4. IDE 扩展在打开前再次执行 workspace、wire path 和 realpath 校验。

## 核心链路

```text
Vue SFC 原始源码
  │
  │ @web-source-inspector/transform-vue
  │ AST 解析 + DOM/组件双 marker 注入 + sourcemap
  ▼
浏览器 DOM + @web-source-inspector/runtime
  │
  │ Adapter Browser Transport，发送 sourceId、browser-scoped token 和必要会话元数据
  ▼
Vite Adapter 或 Webpack Adapter
  │
  │ 内存 Manifest：sourceId -> rootKey + relativePath + SourceRange
  ▼
Loopback WebSocket Bridge
  │
  │ session + bearer token + subprotocol + versioned envelope
  ▼
VS Code/Cursor Extension
  │
  │ realpath containment + VS Code API
  ▼
openTextDocument -> showTextDocument -> Selection -> revealRange
```

## 模块边界

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `protocol` | 协议版本、消息类型、字段限制、错误码、严格校验 | 文件系统、DOM、IDE API |
| `compiler-core` | sourceId、SourceRecord、摘要、路径规范、Manifest、候选解析 | Vue Runtime、网络、打开文件 |
| `transform-vue` | SFC/Template AST、marker 注入、原始范围、sourcemap | Dev Server、Bridge、IDE |
| `runtime` | Shadow DOM UI、命中、高亮、事件拦截、BrowserTransport | 源码路径、源码范围、Manifest、IDE Bridge token |
| `dev-session-core` | Browser Router、Bridge、session descriptor 与生命周期 | bundler 编译钩子、浏览器 UI、IDE API |
| `vite-plugin` | Vite 编译链、Runtime 注入和 Manifest staging/commit | Webpack rule、项目配置写入、IDE API |
| `adapter-webpack` | Webpack Plugin/Loader、WDS/raw transport 和 Manifest 生命周期 | Vite 钩子、IDE API |
| `init-core` | detect/profile、AST plan/apply/remove、doctor 和事务恢复 | 启动 Dev Server、安装 npm 包、打开源码 |
| `web-source-inspector` | 唯一公开包、CLI、Vite/Webpack 子路径和物理 runtime/loader 资产 | 编辑器状态与 Extension API |
| `vscode-extension` | 项目启用、session 发现、workspace 映射、路径复核、源码打开、状态栏；只调用工作区 CLI | Vue AST、浏览器 DOM、shell 拼接、全局 CLI 或自动安装 npm 包 |

## 编译与 SourceRecord

Vite Adapter 以 `enforce: 'pre'` 转换允许范围内的 `.vue` 文件；Webpack Adapter 通过放在 `vue-loader` 前的专用 Loader 处理 template pipeline。两者共用 Vue compiler AST 和坐标逻辑，并在可落到 DOM 的开始标签上插入：

```html
<button data-wsi-source="opaque-id">保存</button>
```

组件调用点使用独立的 `data-wsi-component-source`。Runtime 只把 `data-wsi-source` 视为精确 DOM 来源；组件 marker 可直接从 DOM 或 Vue owner 链读取，普通点击仍优先精确 marker，Shift 点击优先调用点 marker。

每个 AST 节点生成一条内存 `SourceRecord`。关键字段包括：

- `sourceId`：当前 Dev Server session 内的不透明标识。
- `rootKey`、`relativePath`：协议中的项目身份和 POSIX 相对路径。
- `range`：原始 SFC 的 1-based 行列及 UTF-16 offset。
- `kind`、`tagName`、`componentName`、`controlFlow`、`parentSourceId`：候选链。
- `sourceDigest`、短上下文锚点：IDE 内容漂移判断。
- `moduleId`、`generation`：HMR 原子替换身份。

sourceId 使用每次 Dev Server 启动生成的 secret 对协议 major、相对路径、module generation、节点类型、标签、范围和局部摘要做 HMAC。ID 不编码绝对路径，服务重启后允许变化。

### Vue 节点语义

- 原生元素：注入 marker，默认 `exact`。
- 用户组件：组件调用标签可携带 marker，默认 `approximate`。
- `<template>`、Slot、Fragment：保留虚拟记录参与候选链，不直接假设存在 DOM。
- Teleport：Teleport 容器本身不作为业务 DOM marker，内部实际节点仍携带自己的 marker。
- 动态组件：记录动态调用点，按近似候选处理。
- 第三方组件：依赖目录默认不转换，优先退回用户模板中的调用点。
- 不支持的 template `lang` 或外部 `src`：输出明确诊断，不猜测转换。

## Manifest 与增量编译

Manifest 只存在于当前 Vite 或 Webpack Node 进程内存：

1. 真实 development Dev Server 启动时创建空 Manifest 和 session secret；Vite 的 build、preview、`enabled: false` 以及未创建 session 的场景保持 no-op，Webpack 在非 `development` 模式保持 no-op。
2. SFC 转换完成后，以 `moduleId + generation` 原子替换该模块全部记录。
3. 内容未变化时复用 generation；内容变化时递增 generation。
4. 被替换或删除的 sourceId 进入有 TTL 和容量上限的 tombstone。
5. 旧 ID 返回 `SOURCE_STALE`，未知 ID 返回 `SOURCE_NOT_FOUND`。
6. Dev Server 退出时清空 Manifest 并释放 Bridge/session 文件。

旧 sourceId 不会模糊匹配到新节点。这会牺牲一次无刷新重试，但避免 HMR 后打开错误文件或错误位置。

## Browser Runtime

Runtime 由 Adapter 的开发入口注入：Vite 使用虚拟模块，Webpack 使用受控 runtime entry。UI 放在 open Shadow DOM 中，避免业务 CSS 污染，并保持可测试性。

选择状态：

| 状态 | 行为 |
| --- | --- |
| `disabled` | 入口可见，不拦截业务事件 |
| `armed` | hover 高亮，capture 阶段拦截选择目标的业务事件 |
| `opening` | 已发送定位请求，等待 IDE 回执并防止重复选择 |

连接状态独立维护 `connected`、`disconnected`、`stale`、`error`。默认快捷键为 `Alt+Shift+C`，`Esc` 退出；默认成功选择一次后自动退出。

命中顺序为 composed path marker、point hit marker、Vue owner 组件候选、已注册 adapter hit tester。Inspector 自身 host、overlay 和 tooltip 永不作为业务候选。pointermove 使用 `requestAnimationFrame` 节流，不为每个 DOM 节点绑定监听，也不扫描全局 MutationObserver。

## Browser Router

每个 tab 生成随机 `pageClientId` 并先发送 hello；后续 select、dispose 必须绑定到同一 transport client、session 和 pageClientId。Vite 可使用经校验的 HMR custom event；Webpack Dev Server 使用同源 middleware stream，raw Webpack watch 使用独立 loopback transport。

Router 负责：

- 16 KiB 浏览器消息限制和字段校验。
- 默认 `browserAccess: 'same-machine'` 只接受回环地址或启动快照中的本机网卡 socket 地址，并要求非回环页面 Origin 的字面量 IP、协议和实际 listener 端口精确绑定；插件不改写 Vite `server.host`，显式 `loopback` 会拒绝非回环浏览器。
- raw Webpack watch 只接受精确 HTTP Origin；HTTPS Origin 返回 `RAW_WATCH_HTTPS_UNSUPPORTED`。
- hover 只在 sourceId 变化时更新本地候选；浏览器不查询路径或范围 metadata。
- 选择请求限频。
- 将结果只发回发起请求的 pageClientId。
- 多 tab 列表同步给 IDE Bridge。

页面 URL 和标题只用于展示与诊断，不能参与文件路径解析。

## Loopback Bridge

每个活动 Dev Server session 创建随机标识、随机端口、随机路径和高熵 token。Bridge 仅监听 `127.0.0.1`，WebSocket Upgrade 同时校验：

- loopback remote address；
- 随机 bridge path；
- `Authorization: Bearer <token>`；
- `wsi.bridge.v1` subprotocol；
- 协议版本和消息结构。

session 描述文件写入当前用户私有的 runtime/cache 目录，采用临时文件后 rename。扩展只读取大小、类型、权限、PID、心跳和 schema 均有效的文件。

多 IDE 路由优先显式 claim，其次唯一合格客户端，再次唯一 focused 客户端；仍有歧义时返回错误，不广播打开请求。

## IDE 扩展

扩展使用稳定 VS Code API，并声明为 workspace extension。它只在本地、受信任且已打开 workspace 时发现 session；项目管理命令只以参数数组调用 workspace 内安装的 CLI，先预览 diff 并等待确认，不执行 shell、全局包或 npm 安装。

打开请求的处理顺序：

1. 用已认证 session 的 `rootKey` 找到 root mapping。
2. 严格验证 POSIX `relativePath`。
3. 对 session 根、workspace 根和目标执行 realpath。
4. 确认目标真实路径同时位于 session 根和已打开 workspace 内。
5. 确认目标是普通文件。
6. 打开当前 TextDocument buffer。
7. 摘要不一致时，只在附近上下文唯一匹配时校正。
8. 将 1-based 协议位置转换并 clamp 为 VS Code 0-based Position。
9. 设置 Selection 并 reveal。

扩展不调用 shell，不接受浏览器提供的路径，不允许 workspace 外打开。

## 关键 ADR

| 决策 | 结论 | 原因 |
| --- | --- | --- |
| ADR-001 | 精确模式必须安装项目端 Adapter | 最终 DOM 没有可靠原始模板位置 |
| ADR-002 | AST sourceId 是主链路，sourcemap 是补充 | DOM click 没有生成代码坐标可直接查询 source map |
| ADR-003 | 浏览器业务定位数据只发送 sourceId，并携带 Browser Transport 专用认证和必要会话元数据 | 缩小本机文件打开攻击面，同时保持浏览器通道独立认证 |
| ADR-004 | Browser Transport 由 bundler adapter 提供 | Vite HMR、WDS middleware 与 raw watch 生命周期不同，不能强行共用一种传输 |
| ADR-005 | IDE Bridge 只监听 loopback | IDE 控制能力不能暴露到局域网 |
| ADR-006 | 用 VS Code API 打开文件 | VS Code/Cursor 共用 VSIX，不依赖 CLI/URI Scheme |
| ADR-007 | 仅进入开发服务 | 防止生产泄漏源码结构和运行时开销 |
| ADR-008 | Canvas/Three.js 使用独立 adapter | 一个 Canvas DOM 无法区分内部对象 |
| ADR-009 | 项目端本地依赖是正式接入前提 | 最终 DOM 没有可靠原始模板位置，扩展无法在不接入项目构建链的前提下可靠定位 |

## 已知边界

- 首版只承诺本地同机场景；`same-machine` 只扩大 Vite 页面到同一电脑的回环或启动快照网卡 IP，Bridge 仍固定在 `127.0.0.1`，且不会改写 `server.host`。Remote Extension Host 可能与 Vite 的临时目录和 loopback 分离。
- `remoteBrowser` 已弃用且不允许 `true`；代理、端口转发、手机、其它电脑、WSL、Docker、Dev Container 和 Remote SSH 都不在支持范围内。
- 组件内部 DOM 到第三方依赖源码不作保证。
- Canvas、Three.js 对象需要后续独立 hit-test provider。
- 真实 VS Code 和 Cursor 安装兼容必须分别 smoke test，不能仅由 API 类型推断。

后续框架或 Canvas adapter 必须遵守 [Adapter 编写约束](adapter-authoring.md)，当前 `0.1.0-beta.4` 尚未提供稳定的通用 Adapter SDK。
