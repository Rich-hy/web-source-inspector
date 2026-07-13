# 协议

协议的 TypeScript 类型、限制和运行时校验以 `@web-source-inspector/protocol` 为唯一规范。本文件描述 `1.0` 语义，不替代代码中的严格 validator。

## 版本策略

- 当前 `protocolVersion`：`1.0`。
- 当前端点要求精确匹配 `1.0`；不一致时拒绝连接并返回 `PROTOCOL_MISMATCH`。
- 后续同 major 的新增可选能力应通过 `capabilities` 协商，完成兼容实现前不能只放宽版本字符串。
- session 文件另有 `schemaVersion: 1`。
- Bridge WebSocket subprotocol 为 `wsi.bridge.v1`。
- extension、Runtime 和 server 不要求包版本完全一致，但必须满足协议与 capability 约束。

## 通用数据约定

### SourceRange

```ts
interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startOffset: number;
  endOffset: number;
}
```

- 行、列为 1-based。
- offset 是 JavaScript 字符串 UTF-16 code unit offset。
- 范围采用 `[start, end)`。
- 范围对应完整 `.vue` 文件，不是 `<template>` block 内局部坐标。
- IDE 转换到 0-based Position，并对当前文档范围 clamp。

### Wire path

`relativePath` 使用 POSIX `/`，相对于 session 中已认证的 workspace 根。它不是 URL，不执行 URL decode。绝对路径、反斜杠、`.`、`..`、空段、冒号、百分号、NUL、控制字符、Windows 设备名及结尾点/空格均拒绝。

### sourceId 与摘要

- sourceId 是完整 HMAC-SHA-256 的 43 字符 Base64URL 不透明 ID；检测到相同 ID 对应不同记录时 fail closed，不追加碰撞后缀。
- 浏览器不能从 sourceId 解出路径或源码。
- `sourceDigest` 使用完整文件 SHA-256，协议表示为 `sha256:<64 lowercase hex>`。
- 上下文锚点是短文本，受长度上限限制，不用于跨文件搜索。

## Browser 与 Server 事件

Browser Runtime 使用 bundler-neutral payload；Vite HMR、Webpack Dev Server middleware 和 raw Webpack transport 只负责承载同一协议。

| 事件 | 方向 | 用途 |
| --- | --- | --- |
| `wsi:browser:hello` | Browser -> Server | 注册 tab 身份、Runtime 版本、页面摘要和能力 |
| `wsi:browser:heartbeat` | Browser -> Server | transport 保活，绑定 session/page/token |
| `wsi:browser:select` | Browser -> Server | 提交 sourceId、候选类型和修饰键 |
| `wsi:browser:metadata-request` | Browser -> Server | 按 sourceId 请求标签/组件等无路径展示字段 |
| `wsi:browser:dispose` | Browser -> Server | tab unload、HMR dispose 或手动释放 |
| `wsi:server:heartbeat` | Server -> Browser | 返回序号和 server time |
| `wsi:browser:set-mode` | Server -> Browser | 对指定 pageClientId 开关选择模式 |
| `wsi:browser:connection` | Server -> Browser | IDE 连接/歧义状态 |
| `wsi:browser:metadata` | Server -> Browser | sourceId、标签、组件名和控制流类型；不含路径/范围 |
| `wsi:browser:result` | Server -> Browser | 只返回打开状态和错误码，不回传定位信息 |

选择请求的安全关键字段示例：

```json
{
  "protocolVersion": "1.0",
  "sessionId": "session-id",
  "pageClientId": "browser-tab-id",
  "timestamp": 1783651200000,
  "browserToken": "[REDACTED]",
  "tokenAudience": "browser-transport",
  "sourceId": "opaque-base64url-source-id",
  "candidateKind": "element",
  "modifiers": {
    "shift": false,
    "alt": false
  },
  "page": {
    "origin": "http://127.0.0.1:41731",
    "pathname": "/",
    "title": "Web Source Inspector Fixture"
  }
}
```

Server 只能用 `sourceId` 查询当前内存 Manifest。Browser payload 和响应都不包含 relativePath、range 或源码上下文；`page.origin`、pathname、title、candidateKind 和修饰键不能转换为文件路径。修饰键只在服务端已有候选链中调整偏好，pathname 在进入 tab 摘要前移除 query/hash。

## Session 描述文件

每个活动 Dev Server 建立一个 session 描述文件。敏感字段只供本机扩展发现使用，不进入 browser 或 workspace。

```json
{
  "schemaVersion": 1,
  "protocolVersion": "1.0",
  "sessionId": "random-session-id",
  "pid": 12345,
  "port": 49152,
  "bridgePath": "/wsi/random-path",
  "token": "[REDACTED]",
  "createdAt": 1783651200000,
  "heartbeatAt": 1783651205000,
  "projectName": "example-project",
  "canonicalRoots": [
    {
      "rootKey": "root-key",
      "canonicalPath": "[LOCAL_ONLY]",
      "displayName": "example-project"
    }
  ],
  "devOrigins": ["http://127.0.0.1:41731"],
  "capabilities": ["vue", "metadata", "candidate", "remote-toggle"]
}
```

扩展发现时校验普通文件、文件大小、权限/归属、schema、协议、PID、心跳、端口、bridgePath、token 长度、root 和 origin。固定 WebSocket subprotocol 由两端代码约定，不写入 session 文件。过期或损坏文件被忽略。

## CLI JSON API

扩展只调用 workspace 内安装的 CLI JSON API。stdout 必须是唯一一个对象，不能混入提示文本：

```json
{
  "schemaVersion": 1,
  "protocolVersion": "1.0",
  "operation": "init:plan",
  "ok": true,
  "result": {},
  "diagnostics": [],
  "errorCode": null
}
```

允许的 operation 为 `init:plan`、`init:apply`、`doctor`、`remove:plan` 和 `remove:apply`。成功 envelope 的 `errorCode` 必须为 `null`；失败 envelope 必须提供稳定错误码，并与进程退出码一致。Apply 必须回传刚确认的 `planDigest`，配置已变化时返回 `PLAN_STALE`，不能继续应用旧 diff。

## Bridge 包络

所有 Bridge 业务消息使用统一包络：

```json
{
  "protocolVersion": "1.0",
  "messageId": "unique-message-id",
  "type": "server:open-source",
  "sessionId": "session-id",
  "senderId": "server-or-ide-client-id",
  "timestamp": 1783651200000,
  "payload": {}
}
```

规则：

- `messageId` 关联 request/ack，并用于重放/幂等检查。
- 同一个 messageId 携带不同 payload 时返回 `REPLAY_CONFLICT`。
- timestamp 只用于有限重放窗口和诊断，不作为可信全局顺序。
- 未知字段、未知类型、错误枚举、超限数组或超长文本均拒绝。
- Bridge 消息最大 64 KiB，只接受文本 WebSocket frame。
- token 只在 WebSocket Upgrade 的 Authorization header 中提交，不放 URL query 或普通消息。

## Bridge 消息类型

| 类型 | 方向 | 说明 |
| --- | --- | --- |
| `ide:hello` | IDE -> Server | IDE 类型/版本、workspace roots、能力 |
| `server:hello-ack` | Server -> IDE | `authenticated`、session 摘要、browserTabs |
| `ide:claim` | IDE -> Server | `{ claim: boolean }` 声明或释放当前 IDE |
| `server:claim-result` | Server -> IDE | 返回 `{ claimed: boolean }` |
| `ide:focus` | IDE -> Server | `{ focused: boolean }` 更新窗口状态 |
| `heartbeat` | 双向 | 保活和断线发现 |
| `server:open-source` | Server -> IDE | 请求打开已由 Manifest 解析的源码候选 |
| `ide:open-result` | IDE -> Server | `requestMessageId + ok` 及可选结果字段 |
| `ide:set-browser-mode` | IDE -> Server | `enabled` 及可选 pageClientId |
| `server:tabs-changed` | Server -> IDE | `{ browserTabs }` 列表变化 |
| `server:session-dispose` | Server -> IDE | 当前使用 `dev-server-closed` 表示服务退出 |
| `error` | 双向 | 稳定错误码和 requestMessageId |

当前握手 payload：

```json
{
  "type": "ide:hello",
  "payload": {
    "ideClientId": "ide-window-id",
    "ideName": "VS Code",
    "extensionVersion": "0.1.0",
    "workspaceRoots": [
      { "rootKey": "root-key", "canonicalPath": "[LOCAL_ONLY]" }
    ],
    "capabilities": ["open-source", "context-relocation", "browser-mode"],
    "focused": true
  }
}
```

认证成功的 hello ack：

```json
{
  "authenticated": true,
  "session": {
    "sessionId": "session-id",
    "projectName": "example-project",
    "canonicalRoots": [
      { "rootKey": "root-key", "displayName": "example-project" }
    ],
    "capabilities": ["vue", "metadata", "candidate", "remote-toggle"]
  },
  "browserTabs": [
    {
      "pageClientId": "browser-tab-id",
      "pathname": "/",
      "title": "Web Source Inspector Fixture",
      "connectedAt": 1783651200000
    }
  ]
}
```

## 打开源码请求

`server:open-source` 的 payload 只能包含服务端可信记录及非敏感页面展示信息：

- `openRequestId`、`pageClientId`。
- `rootKey`、`relativePath`、`range`。
- `sourceDigest`、可选 `contextBefore/contextAfter`。
- `accuracy`、`candidateKind`、`tagName`、可选 `componentName`。
- 页面 origin/pathname/title 只用于显示，不能参与路径解析。

请求不包含 shell 命令或绝对路径。扩展只接受 `rootKey + relativePath`，并且不能绕过自身 workspace realpath 校验。

## 候选与结果

浏览器候选偏好类型：

```text
element | component | call-site | control-flow | dynamic | three
```

Bridge 当前把已解析主记录的 `candidateKind` 作为受限字符串发送；Vue 实现常见值还包括内部记录语义 `fragment`、`slot`。IDE 只将其用于显示，不据此构造路径。

定位精度：

```text
exact | approximate
```

IDE 回执使用 `requestMessageId` 对应 `server:open-source` 的 messageId，并以 `ok` 表示成功或失败。可选字段为 `code`、`message`、`relativePath`、`line`、`accuracy`；回执不返回绝对路径。

`RANGE_ADJUSTED` 表示在当前 TextDocument 中通过唯一上下文校正；`RANGE_STALE` 表示摘要不一致且无法唯一校正，扩展仍只打开原文件中的保守位置，不跨文件猜测。

## 稳定错误码

| 错误码 | 处理语义 |
| --- | --- |
| `PROTOCOL_MISMATCH` | 当前版本字符串不兼容，停止自动重试并升级对应端 |
| `AUTH_FAILED` | token/session/subprotocol 认证失败，断开且不输出 secret |
| `IDE_NOT_CONNECTED` | 无可用 IDE，浏览器仍可退出选择模式 |
| `IDE_SELECTION_REQUIRED` | 多 IDE 无唯一处理者，要求显式选择 |
| `SOURCE_NOT_FOUND` | 当前 Manifest 没有该 ID |
| `SOURCE_STALE` | ID 属于已替换 generation，不猜测新位置 |
| `WORKSPACE_NOT_MATCHED` | rootKey 未映射到当前 workspace |
| `PATH_REJECTED` | wire path、realpath 或 containment 校验失败 |
| `FILE_NOT_FOUND` | 目标不存在或不是普通文件 |
| `RANGE_ADJUSTED` | 已按唯一上下文校正 |
| `RANGE_STALE` | 页面和编辑器内容不一致，无法唯一校正 |
| `TARGET_UNSUPPORTED` | 目标属于明确不支持或无可信候选场景 |
| `RATE_LIMITED` | 浏览器选择过快 |
| `MESSAGE_TOO_LARGE` | 消息超过端点上限 |
| `INVALID_MESSAGE` | schema、类型、枚举或字段约束失败 |
| `UNKNOWN_MESSAGE_TYPE` | 消息类型不在当前协议中 |
| `REPLAY_CONFLICT` | 重用 ID 但内容不同 |
| `IDE_REQUEST_TIMEOUT` | IDE 打开请求超时 |
| `PLAN_CONTEXT_REQUIRED` | 计划缺少无法安全推断的用户输入 |
| `PLAN_STALE` | 配置内容或答案已变化，必须重新生成并确认计划 |
| `RECOVERY_REQUIRED` | 检测到待恢复事务，先完成保守恢复 |
| `TRANSACTION_CONFLICT` | 锁、journal、文件身份或所有权不一致，拒绝写入 |
| `TEMPLATE_PIPELINE_MISMATCH` | Webpack template loader chain 与预期不一致 |
| `MULTI_COMPILER_UNSUPPORTED` | 当前 development 配置为不支持的 MultiCompiler |
| `WDS_TRANSPORT_UNSUPPORTED` | 无法安全挂载 Webpack Dev Server transport |
| `SOURCE_ID_COLLISION` | 不同源码记录产生相同 sourceId，当前 build fail closed |
| `BUILD_SUPERSEDED` | 当前 staging build 已被更新编译替代 |
| `INTERNAL_ERROR` | 未分类错误，只返回脱敏码/traceId |

## 主要限制

| 项目 | 上限 |
| --- | --- |
| Browser 消息 | 16 KiB |
| Bridge 消息 / session 描述 | 各 64 KiB |
| CLI JSON stdout | 1 MiB |
| sourceId | 固定 43 字符 |
| browser tabs / connections | 各 256 |
| Browser pending request | 1024 |
| capability | 64 项 |
| workspace roots | 64 项 |
| 相对路径 | 1024 字符（扩展仍可执行更严格限制） |
| canonical path | 4096 字符，仅本机 session/IDE 使用 |
| 上下文锚点 | 每段 256 字符 |

端点可以采用更严格的上限，但不能放宽安全边界后仍声称与协议完全兼容。
