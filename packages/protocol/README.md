# @web-source-inspector/protocol

Web Source Inspector 的共享 wire 类型、事件名、版本常量、字段上限和运行时校验器。

## Status

当前版本为 `0.1.0` 开发实现，尚未声明已发布到 npm。仓库内包通过 `workspace:*` 使用它。

## Main Exports

- `PROTOCOL_VERSION`、`BRIDGE_SUBPROTOCOL`、`SESSION_SCHEMA_VERSION`。
- `BROWSER_EVENTS` 和 `PROTOCOL_LIMITS`。
- Browser、Vite、Bridge、session、候选和错误码类型。
- `validate*` / `parse*` 运行时校验器。
- `isSourceId`、`isWireRelativePath`、`validateSourceRange`。
- `createProtocolEnvelope` 和协议版本兼容检查。

```ts
import {
  BROWSER_EVENTS,
  PROTOCOL_VERSION,
  validateBrowserToVitePayload,
} from '@web-source-inspector/protocol';

const result = validateBrowserToVitePayload(BROWSER_EVENTS.hello, payload);
if (!result.ok) {
  throw new Error(`${result.error.code}: ${result.error.path}`);
}

console.log(PROTOCOL_VERSION, result.value.pageClientId);
```

所有不可信消息都应先经过本包 validator，再进入业务逻辑。包版本不能代替 protocol/capabilities 协商；当前端点行为以仓库协议文档为准。

## Security

Browser 消息、Bridge frame、路径、ID、数组和上下文均有显式上限。不要在上层放宽绝对路径、token、源码正文或 shell 命令等安全边界。

## License

MIT，见 [LICENSE](LICENSE)。
