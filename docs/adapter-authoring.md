# Adapter 编写约束

本文说明 Web Source Inspector adapter 必须遵守的安全和数据约定。`0.1.0` 尚未提供稳定、可注册的通用 Adapter SDK；当前公开实现包含 Vue SFC transform、Vite Adapter、Webpack/Vue CLI Adapter 和 Runtime `registerHitTester`。因此本文是后续框架或 Canvas adapter 的设计合同，不是对 React、Three.js 等目标即插即用支持的声明。

## Adapter 的职责边界

一个完整 adapter 通常包含两部分：

1. 构建期转换：把框架源码节点转换成 `SourceRecord`，生成 sourceId，并在可定位的运行时对象上附加不透明 marker 或注册信息。
2. 运行时命中：从 PointerEvent、DOM、Canvas 或框架实例中找到 sourceId，只返回候选，不解析路径。

路径解析、Manifest 生命周期、Bridge 认证和 IDE 打开必须继续由可信的 Vite/server/Extension 层负责。Adapter 不得让 Browser 直接发送路径、URI、行列、shell 命令或 Bridge token。

## 可复用包

| 包 | Adapter 可使用的能力 |
| --- | --- |
| `@web-source-inspector/protocol` | 公共类型、事件名、字段上限和运行时 validator |
| `@web-source-inspector/compiler-core` | sourceId 生成、摘要、`SourceRecord`、候选排序、wire path 和 `SourceManifest` |
| `@web-source-inspector/runtime` | DOM 命中与 `RuntimeHitTester` 注册接口 |
| `@web-source-inspector/transform-vue` | Vue AST transform 的参考实现，不是通用 parser |
| `@web-source-inspector/dev-session-core` | bundler-neutral Browser Router、Bridge 与 session 生命周期参考合同 |
| `@web-source-inspector/vite-plugin` | Vue/Vite 集成；尚未暴露外部 Manifest adapter 注册 API |
| `@web-source-inspector/adapter-webpack` | Vue/Webpack/Vue CLI Plugin、Loader 与 transport 参考实现 |

不要从包内部路径导入未导出的文件。0.x 内部结构可变化，只有 package exports 中的符号可作为候选公共接口。

## SourceRecord 不变量

Adapter 生成的记录必须满足：

- `rootKey` 代表当前认证 workspace 根，不是磁盘路径本身。
- `relativePath` 是 workspace 相对 POSIX 路径，不能包含绝对路径、反斜杠、`.`、`..`、空段、URI 或编码路径。
- `range` 使用 1-based 行列、UTF-16 offset 和 `[start, end)`，坐标针对完整源文件。
- `sourceDigest` 来自完整文件，局部 snippet digest 只能作为辅助锚点。
- sourceId 使用 session 私钥和稳定输入生成；不能包含可逆路径或源码。
- 同模块同内容的 ID 应稳定；内容变化必须推进 generation，使旧 ID 返回 stale，而不是猜测新位置。
- `accuracy`、`kind`、`candidateKind` 和 label 必须反映真实语义，不把近似结果伪装成精确。

## 构建期流程

推荐顺序：

1. 只处理显式允许的用户源码，排除 `node_modules`、产物、虚拟模块和磁盘根级扫描。
2. 使用框架 parser/AST，不用正则或字符串搜索推断节点边界。
3. 把 parser 坐标转换成完整文件的 UTF-16 范围。
4. 先收集全部记录，再通过 Manifest 的模块级替换流程完成碰撞消歧和原子提交。
5. 根据最终 sourceId 注入 marker 或生成运行时注册表。
6. 保留原始 sourcemap，并检查 sources/sourcesContent 不泄漏本机绝对路径。
7. 删除模块时移除记录；HMR 更新时保留受限 tombstone，禁止用旧 ID 打开其它位置。

转换失败应返回结构化诊断并保留原源码。不能为了“尽量定位”输出损坏代码或任意祖先文件。

## DOM Marker

当前保留属性：

- `data-wsi-source`：实际 DOM 声明位置。
- `data-wsi-component-source`：组件调用点或组件候选。

Adapter 必须检测用户模板中的同名属性冲突；发生冲突时跳过该节点并给出诊断，不能覆盖业务值。普通点击应优先实际 DOM，Shift 等候选语义由 Runtime/Router 共同决定。

## Runtime Hit Tester

`RuntimeHitTester` 适合为动态 DOM 或 Canvas 提供 sourceId 命中。它只负责返回候选：

```ts
const unregister = runtime.registerHitTester({
  hitTest(event) {
    const sourceId = resolveRegisteredSourceId(event);
    return sourceId
      ? { element: canvasElement, sourceId, kind: 'dynamic' }
      : null;
  },
});
```

`resolveRegisteredSourceId` 必须来自受控注册表。不要把调试字段写入 Three.js `userData`、业务序列化对象或持久化数据；优先使用 `WeakMap<object, sourceId>`。注销 adapter、HMR dispose 和页面卸载时必须清理监听与引用。

当前 Vite 插件没有对外暴露把第三方 adapter 记录注入其 Manifest 的稳定 API。单独注册 hit tester 不能构成端到端对象定位；在正式开放前需要先设计受校验的 server-side record provider 合同。

## 协议与能力协商

- 新消息字段优先设计为可选字段，并由 `@web-source-inspector/protocol` validator 统一约束。
- 不兼容变更提升 protocol major；同 major 能力通过 capabilities 显式协商。
- capability 名称应稳定、具体并有字段上限，不能通过包版本猜测支持情况。
- Browser 输出不包含路径、行列、源码上下文或 IDE 凭据；只允许 sourceId、会话绑定、候选展示字段、状态和错误码等受限数据。
- 未知 capability、消息类型或候选类型必须安全拒绝或降级，不能导致进程崩溃。

## 安全要求

- Adapter 只在开发 serve 模式启用，生产 build 必须完全不加载 Runtime、marker、Manifest 或 Bridge。
- 不启动额外监听 `0.0.0.0` 的控制端口，不把 token 放入 URL、DOM、日志或 workspace。
- 不执行 shell，不接受 Browser 提供的路径，不绕过 Extension 的 realpath/workspace 校验。
- 消息、数组、上下文、缓存、Manifest 和 tombstone 必须有大小、容量或 TTL 上限。
- 错误日志使用诊断码和相对路径，默认不记录源码正文。

## 验证清单

新增 adapter 至少需要：

- parser fixture：多行、CRLF、Unicode、BOM、空格/中文路径和语法错误。
- 结构 fixture：循环、条件、组件、slot/fragment、动态节点和 adapter 特有边界。
- sourceId 稳定、碰撞、generation、stale 和模块删除测试。
- sourcemap 回映及绝对路径扫描。
- Runtime 命中、Inspector 排除、事件副作用和 dispose 清理。
- 真实 dev server 浏览器 E2E，以及 IDE 打开 URI/selection 的证据。
- 生产构建字符串扫描和 npm tarball/许可证检查。
- 能力矩阵更新，明确精确、近似、不支持和未验证范围。

Vue 实现细节见 [architecture.md](architecture.md)，协议约束见 [protocol.md](protocol.md)，安全底线见 [security.md](security.md)。
