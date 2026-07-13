# 安全模型

Web Source Inspector 能触发 IDE 打开本机文件，因此即使只在开发态运行，也必须把浏览器、Dev Server、临时文件和 IDE 消息视为不同信任域。

## 安全目标

- 浏览器不能指定本机路径、URI、命令或任意行号。
- 局域网客户端不能直接连接 IDE Bridge。
- 伪造、过期或未知 sourceId 不能打开其它源码。
- IDE 只能打开当前受信 workspace 中、经 realpath 复核的普通文件。
- 多 IDE 时一次请求最多交给一个明确目标。
- token、绝对路径、源码正文和 URL 查询参数不进入浏览器或普通日志。
- 消费项目生产产物不包含 Inspector Runtime、marker、Bridge 或 Manifest 信息。

## 威胁模型

需要防御的输入包括：

- 访问 Vite 页面或伪造 HMR 消息的其它浏览器。
- 页面内第三方脚本读取 DOM marker 或发送选择请求。
- 猜测/重放 sourceId、session、messageId 或旧 token。
- 伪造或替换 session 描述文件。
- 路径穿越、Windows 盘符/UNC/设备路径、符号链接和 Junction 逃逸。
- 超大 JSON、二进制 frame、超长字段、候选膨胀和高频点击。
- 多 Dev Server、多 tab、多 IDE 窗口连接到错误 workspace。
- 未受信 workspace 或 Remote Extension Host 的不一致文件系统。

不在当前目标内：防御已经完全控制同一用户账户、IDE Extension Host 或 Vite Node 进程的恶意代码。此类代码已经拥有与 Inspector 相当或更高的本机权限。

## 信任边界

```text
不可信/低信任                  可信解析层                  本机高权限动作

Browser page  ->  Dev Server sourceId Manifest  ->  Loopback Bridge  ->  IDE Extension
  opaque ID              trusted record             authenticated       realpath + API
```

浏览器不接收 relativePath、SourceRange、源码上下文或 Bridge token。标签名、组件名和连接状态只来自当前 DOM/Runtime 状态，不能反向成为文件打开输入。

## Browser 边界

- DOM/组件只注入不透明的 `data-wsi-source` 与 `data-wsi-component-source`，不注入绝对路径、token 或源码正文。
- Browser 请求上限为 16 KiB。
- pageClientId 必须先 hello，并绑定到同一个经认证 Browser Transport client。
- selection 按 tab 限频，消息必须绑定当前 session/page/request。
- Dev Server 只查询当前进程内 Manifest；未知或过期 ID 分别返回 `SOURCE_NOT_FOUND`、`SOURCE_STALE`。
- 页面 URL/title 仅用于展示，query/hash 不得参与文件解析或普通诊断。

页面内脚本能够读取当前 DOM 的 sourceId，因此 sourceId 不是认证凭据。安全性来自它只能索引当前 Manifest、Bridge 不暴露给浏览器以及 IDE 端二次路径校验。

## 远程浏览器

默认 `remoteBrowser: false`，Browser Router 拒绝非 loopback 客户端。

当前公开配置类型只允许 `remoteBrowser: false`，配置解析也会强制关闭。尚未提供一次性配对码或短期授权租约，因此不得声明支持手机或其它电脑触发 IDE。未来设计远程浏览器能力时仍必须满足：

- 远端浏览器永远拿不到 Bridge token。
- 显式、短期、可撤销配对。
- origin 校验和明显的远程连接状态。
- 仍只允许提交当前 Manifest 的 sourceId。

## Bridge 边界

Bridge 的最低约束：

- HTTP/WebSocket 仅监听 `127.0.0.1`，不监听 `0.0.0.0`。
- 由操作系统分配随机端口，并使用随机 bridge path。
- token 至少 256 bit 随机输入。
- Upgrade 校验 `Authorization: Bearer` 和 `wsi.bridge.v1` subprotocol。
- 拒绝非 loopback remote address、错误 path、错误 token 和错误 subprotocol。
- 普通 HTTP 请求返回 404；token 不进入 URL query。
- Bridge frame 最大 64 KiB，只接受文本消息。
- envelope 校验 session、sender、timestamp、type、字段上限和 messageId 幂等。
- 心跳超时清理客户端，请求超时清理 pending open。

认证失败日志只能记录 `AUTH_FAILED` 等错误码，不得记录请求 header 或 token 值。

## Session 文件

优先目录：

| 平台 | 目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\web-source-inspector\sessions\` |
| macOS | `~/Library/Caches/web-source-inspector/sessions/` |
| Linux | `$XDG_RUNTIME_DIR/web-source-inspector/sessions/` |

受控 fallback 使用当前用户临时/cache 目录。session 文件采用临时文件写入后原子 rename；Unix 尽量使用目录 `0700`、文件 `0600`。

扩展发现时拒绝：

- 目录或文件 symlink。
- 非普通文件、超过 64 KiB 的文件。
- 非当前用户拥有或组/其它用户可读写的 Unix 文件。
- schema/protocol、端口、bridgePath、token、root、origin 或 capability 不合法的 JSON。
- PID 不存在、心跳超时或未来时间异常的 session。

正常退出删除描述文件；异常退出的陈旧文件由 PID、心跳和 TTL 共同判定，不单凭文件名信任。

`wsi.bridge.v1` 是 Extension 与 Bridge 代码中的固定 WebSocket subprotocol，不从 session JSON 动态读取。

## IDE 路径校验

IDE 扩展收到 `rootKey + relativePath` 后执行两层校验。

### Wire path 语法

拒绝以下输入：

```text
../secret.txt
..\secret.txt
C:\Windows\win.ini
C:relative.txt
/etc/passwd
\\server\share\file
\\?\C:\Windows\win.ini
file:///C:/Windows/win.ini
packages/../secret
packages//src/file.vue
packages/./src/file.vue
packages/%2e%2e/secret
```

同时拒绝 NUL/控制字符、反斜杠、冒号、百分号、`~`、空路径段、Windows 设备名、结尾点/空格和超长路径。

### 真实路径 containment

1. rootKey 必须映射到当前已认证 session 的 canonical root。
2. session root 必须能 realpath。
3. 目标先在 session root 下做 lexical resolve 和 containment。
4. 目标 realpath 后仍必须位于 session root。
5. 目标 realpath 还必须位于当前打开 workspace 的某个 real root。
6. multi-root 使用最长合法包含根。
7. 目标必须存在且是普通文件。

包含关系使用 `path.relative` 和目录边界，Windows 下做大小写无关比较。不能使用字符串 `startsWith()`，否则 `project` 与 `project-evil` 会产生前缀混淆。

扩展当前没有 `allowOutsideWorkspace` 设置，workspace 外打开不可配置开启。

## Workspace Trust 与 Remote

- untrusted workspace 不发现、连接或打开源码。
- 没有打开 workspace 时不连接。
- WSL、Remote SSH、Dev Container、Codespaces 等首版明确拒绝。
- 原因是 Vite、session 临时目录、loopback 和 Extension Host 可能不在同一机器/文件系统。

未来支持 Remote 时需要明确 Extension Kind、远端 session 目录和受控端口转发方案；不得通过监听 `0.0.0.0` 绕过问题。

## 未保存文件

IDE 打开当前 TextDocument buffer，不用磁盘内容覆盖未保存修改：

1. 完整摘要一致时使用协议位置。
2. 摘要不一致且开启 relocation 时，在目标附近使用短上下文锚点。
3. 只有唯一匹配才校正，并返回 `RANGE_ADJUSTED`。
4. 无匹配或多匹配时保守打开原位置，返回 `RANGE_STALE`。
5. 不跨文件搜索或猜测其它组件。

## 日志与隐私

- 默认仅输出错误码、版本、连接状态、tab 数和 session 短 ID。
- 浏览器 console 不输出 token 或绝对路径。
- Dev Server debug 日志使用相对路径或诊断码。
- Extension diagnostics 省略绝对路径，并脱敏 Authorization、token、用户目录和 URL query。
- 不记录源码正文；上下文锚点只存在于受限内存消息。
- 当前不启用遥测。

用户提交诊断前仍应人工检查，特别是第三方扩展或构建插件可能写入同一个输出环境的内容。

## 多实例路由

- 每个活动 Dev Server 一个 sessionId。
- 每个浏览器 tab 一个 pageClientId。
- 每个 IDE 窗口一个 ideClientId。
- 优先显式 claim，其次唯一匹配客户端，再次唯一 focused 客户端。
- 有歧义时返回 `IDE_SELECTION_REQUIRED`/选择提示。
- open result 通过 pending request 绑定原 pageClientId，不能广播给所有 tab 或 IDE。

## 生产构建核验

Vite Adapter 只在真实 `serve` 生命周期创建 session；Webpack Adapter 只在 development Dev Server/受支持 watch transport 中启用。发布消费应用前仍要构建并检查实际产物。以下命令中的 `<app>`、`<dist>` 替换为消费项目脚本和输出目录：

```powershell
pnpm --filter <app> build
rg -n "data-wsi-(source|component-source)|wsi:browser:|web-source-inspector:client|wsi\.bridge|/wsi/" <dist>
rg -n "[A-Za-z]:[\\\\/]" <dist>
```

预期两次 `rg` 都没有命中。还需确认：

- 业务入口没有静态 import `@web-source-inspector/runtime`。
- 构建配置没有手动把 Inspector runtime/loader 加入生产入口，也没有绕过 Adapter 的 mode/lifecycle 检查。
- 产物不含 session JSON、token、端口、Manifest 或绝对源码路径。
- source map 发布策略符合消费项目要求；Inspector 自身不能额外泄漏源码。

生产页面出现按钮或 marker 属于阻断发布问题。

## 安全问题报告

私下报告方式、受支持版本和披露流程见仓库根 [SECURITY.md](../SECURITY.md)。当前没有公开安全邮箱；优先使用托管平台的 Private vulnerability reporting/Security Advisory，报告中不得附带真实 token、私有源码或未脱敏绝对路径。
