# 故障排查

先运行 `Source Inspector: Show Diagnostics` 获取脱敏状态。诊断只应包含版本、信任状态、连接状态、session 短 ID、root/tab 数和错误码。

## 浏览器没有 Inspector 按钮

按顺序检查：

1. 当前运行的是 Vite/Webpack/Vue CLI 开发服务器，不是 preview 或生产构建。
2. 已执行 `npx web-source-inspector init` 或扩展的 **Enable Project**，且配置文件中存在公开包接入。
3. 当前开发命令实际加载了被修改的配置；可运行 `npx web-source-inspector doctor` 检查。
4. `ui` 没有设为 `false`，`enabled` 没有设为 `false`。
5. 项目本地能解析 `web-source-inspector` 及对应 `/vite` 或 `/webpack` 子路径。
6. 浏览器控制台和 Dev Server 输出是否有 runtime、loader、middleware 或 transport 诊断。

生产页面没有按钮是正确行为。

## 按钮存在但 DOM 没有 marker

- 确认目标来自 `.vue` template，而不是运行时 `innerHTML`、Canvas 或第三方依赖内部模板。
- 检查文件是否被 `sourceRoots`、`include` 或 `exclude` 排除。
- `node_modules`、`dist`、`.git` 始终不转换。
- 外部 `<template src>` 和非 HTML `template lang` 当前不支持，Vite 日志会给出诊断。
- 业务模板不能自行使用保留属性 `data-wsi-source` 或 `data-wsi-component-source`；冲突节点会跳过注入并告警。
- `<template>`、Slot 和 Fragment 是虚拟候选，本身不一定对应 DOM marker；检查其实际子节点。

## tooltip 没有文件位置

这是当前安全设计，不是故障。Browser 协议不包含 relativePath、行列或源码上下文，tooltip 只显示标签/组件和连接、选择状态。

如果点击后 IDE 没有打开源码，再检查：

- Browser Transport 是否已连接。
- 当前 DOM 是否存在有效 marker，sourceId 是否仍在当前 Manifest 中。
- 页面是否通过非 loopback 地址访问，而 `remoteBrowser` 保持默认 `false`。
- 目标是否只有组件调用点 fallback，或属于明确不支持的动态 DOM。

浏览器中出现盘符、UNC、`/home/...`、workspace 相对路径或源码行列时，都应停止使用并按安全问题处理。

## 按钮显示 IDE 未连接

检查：

1. 业务项目已安装最新的本地 npm 包，并重新执行过 `npx web-source-inspector init`。
2. 初始化器修改配置后，已完整重启原来的 `dev`/`serve` 进程；只刷新浏览器不足以重新加载构建配置。
3. Vue CLI 3 / Webpack Dev Server 3 的自动 hook 使用 `before(app, server)`，并把 `server.compiler` 传给 `createWebSourceInspectorBrowserMiddleware`。Vue CLI 3 不会提供可靠的第三个 `compiler` 参数。
4. VSIX 已安装并 reload。
5. IDE 打开的是当前 Dev Server session 对应的本地 workspace。
6. workspace 已受信任。
7. 当前不是 WSL、Remote SSH、Dev Container 或其它 Remote 环境。
8. Adapter 配置 `bridge` 没有设为 `false`。
9. 状态栏是否显示发现 session；必要时执行 `Source Inspector: Connect Session`。
10. 多 session 时通过 `Source Inspector: Choose Session/Tab` 明确选择。

session 默认目录见 [安全模型](security.md#session-文件)。Windows 默认使用 `%LOCALAPPDATA%\web-source-inspector\sessions`。session 文件不存在通常表示 Bridge 未启动；存在但扩展不发现时，检查 schema、PID、心跳、bridgePath、文件类型和权限。subprotocol 是两端固定的 `wsi.bridge.v1`，在 WebSocket 握手阶段校验。

## 连接被拒绝或反复重连

常见诊断码：

| 诊断 | 含义/动作 |
| --- | --- |
| `PROTOCOL_MISMATCH` | Runtime/Vite/Extension major 不兼容；协调升级 |
| `AUTH_FAILED` | token、session 或 Upgrade 认证失败；重启 Dev Server 生成新 session |
| `SUBPROTOCOL_REJECTED` | 两端 `wsi.bridge.v1` 不一致 |
| `SESSION_EXPIRED` | Vite 已退出或心跳过期；重新启动并连接 |
| `HEARTBEAT_TIMEOUT` | Bridge 无响应；检查进程和本机安全软件 |
| `WORKSPACE_NOT_MATCHED` | IDE workspace 与 session canonical root 无交集 |

认证/协议错误属于 fatal rejection，不应无限重试。不要手工修改 token 或把它复制到 URL。

## 开启选择模式后点击没有打开源码

- 按钮 `aria-pressed` 应为 `true`，光标为 crosshair。
- 目标必须有可信 marker 或组件候选。
- `IDE_NOT_CONNECTED`：先连接扩展。
- `IDE_SELECTION_REQUIRED`：多个 IDE 中没有唯一处理者，手动选择 session/tab。
- `RATE_LIMITED`：等待至少一个短间隔后重试。
- `SOURCE_STALE`：HMR 已替换该记录，刷新或等待 HMR 完成后重新选择。
- `SOURCE_NOT_FOUND`：该 ID 不属于当前 Manifest，刷新页面。
- `TARGET_UNSUPPORTED`：动态 DOM、Canvas 或其它无可信候选目标。
- `IDE_REQUEST_TIMEOUT`：IDE 未在超时窗口回执，检查 Bridge/Extension diagnostics。

点击定位时业务 handler 不执行是预期行为。

## 选择模式影响业务操作

选择模式会阻止 pointerdown、pointerup、click 和 contextmenu，避免提交、删除、导航、拖拽或 OrbitControls 副作用。

- 按 `Esc` 或再次点击 Inspector 按钮退出。
- 退出后按钮 `aria-pressed` 应为 `false`，业务操作应恢复。
- HMR 后出现两个按钮通常表示旧 Runtime dispose 失败；刷新并检查虚拟模块 dispose。
- 退出后仍吞事件属于阻断问题，记录可复现步骤和 Runtime 版本。

## Teleport、Slot 或多根组件定位异常

- Teleport 内容应在目标容器中保留内部实际节点 marker。
- `<slot>` 本身不产生 DOM marker；slot 内容优先定位到消费方模板中的实际节点。
- 多根组件会有虚拟 Fragment 记录；实际根节点分别定位。
- `inheritAttrs: false` 时组件 marker 不一定落到内部根，Runtime 会尝试 Vue owner 调用点 fallback。
- 动态组件属于近似候选，结果可能是用户 `<component :is>` 调用行。

## Element Plus 只能定位到组件调用点

这是默认降级，不是依赖内部定位承诺。`node_modules` 不注入 marker；对 `<el-*>` 等第三方组件，优先打开用户项目中的调用点。不要为追求内部定位而把整个依赖目录加入 sourceRoots。

## HMR 后提示 sourceId 过期

模块内容变化后 generation 递增，旧记录进入短期 tombstone。旧页面/DOM 提交旧 ID 时返回 `SOURCE_STALE`，不会尝试按相似标签打开新位置。

操作：等待当前 HMR 完成并重新 hover；仍使用旧 DOM 时刷新页面。频繁 stale 需要检查模块是否被重复、不稳定地改写。

## 打开文件被拒绝

| 错误码 | 检查项 |
| --- | --- |
| `WORKSPACE_NOT_MATCHED` | IDE 是否打开正确 workspace；monorepo `workspaceRoot` 是否一致 |
| `PATH_REJECTED` | relativePath 是否为严格 POSIX 相对路径；symlink/Junction 是否越界 |
| `FILE_NOT_FOUND` | 文件是否删除、移动，目标是否为普通文件 |

扩展不会提供“仍然打开”按钮，也不能配置 workspace 外放行。修复根映射或文件状态后重新选择。

## 打开的行列偏移

- 检查页面对应的 Vite 编译版本与 IDE 当前 buffer 是否一致。
- 未保存修改导致摘要变化时，扩展只在上下文唯一匹配时返回 `RANGE_ADJUSTED`。
- `RANGE_STALE` 表示无法唯一校正，扩展打开保守原位置。
- CRLF、BOM、中文、emoji 和 tab 需要按完整 SFC 的 UTF-16 坐标验证。
- 非 HTML template 预处理器当前不支持。

不要通过跨文件全文搜索自动修正，容易打开错误组件。

## 多个 IDE 或浏览器 tab 串线

- 用 `Source Inspector: Choose Session/Tab` 固定目标 tab。
- 确认只有期望的 IDE 窗口 claim session。
- 同时存在 VS Code 和 Cursor 且都 focused/eligible 时，应要求选择，不应广播。
- 结果必须回到发起选择的 pageClientId；另一 tab 出现成功提示属于路由缺陷。

记录 session 短 ID、两个 tab 标题、IDE 类型和诊断码，勿记录 token。

## Remote 环境不可用

首版主动拒绝 WSL、Remote SSH、Dev Container 和 Codespaces。这不是端口配置问题；Extension Host、临时目录、loopback 和源码文件可能不在同一台机器。

不要把 Bridge 改为监听 `0.0.0.0`。需要 Remote 支持时，应单独设计远端 workspace extension 和受控端口转发。

## 生产页面出现 Inspector

立即阻断发布：

1. 确认使用的是生产 build，不是 dev/preview 指向 dev 产物。
2. 检查 Vite Adapter 的 serve lifecycle，以及 Webpack Adapter 的 development/no-op 判断没有被绕过。
3. 搜索业务入口是否直接 import Runtime。
4. 搜索产物中的两个 `data-wsi-*` marker、`wsi:browser:`、virtual client 和 Bridge 字符串。
5. 检查构建插件是否被二次包装并绕过 command。

核验命令见 [安全模型](security.md#生产构建核验)。

## 提交诊断信息

建议包含：

- 操作系统、Node/包管理器、Vue、Vite 或 Webpack/Vue CLI、扩展版本。
- VS Code 或 Cursor 版本，是否 Remote。
- fixture/消费项目类型和最小复现步骤。
- `Source Inspector: Show Diagnostics` 的脱敏输出。
- 浏览器错误码和 Dev Server 脱敏诊断码。

不得包含 token、Authorization header、session 文件原文、私有源码、URL query 或未脱敏绝对路径。
