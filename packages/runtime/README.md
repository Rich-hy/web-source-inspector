# @web-source-inspector/runtime

Web Source Inspector 的浏览器端 DOM 选择 Runtime，提供 Shadow DOM 工具入口、高亮、tooltip、快捷键、事件隔离和 bundler-neutral Browser transport 合同。

## Status

当前版本为 `0.1.0` 开发实现，尚未声明已发布到 npm。Runtime 通常由 `@web-source-inspector/vite-plugin` 在开发页面自动注入，业务入口不应直接静态导入。

## Main Exports

- `createInspectorRuntime`。
- `findSourceCandidate` 和 `isShortcut`。
- `BrowserTransport`、`RuntimeHitTester` 和 Runtime 状态类型；`RuntimeTransport` 是兼容别名。
- `SOURCE_ATTRIBUTE`、`COMPONENT_SOURCE_ATTRIBUTE` 和 Browser 事件名。

直接调用需要提供受控 transport、当前 sessionId 和 browser-scoped token：

```ts
import { createInspectorRuntime } from '@web-source-inspector/runtime';

const runtime = createInspectorRuntime({
  sessionId,
  browserToken,
  transport,
  singleShot: true,
});

runtime.enable();
// HMR dispose 或页面清理时调用：
runtime.dispose('hmr');
```

`RuntimeHitTester` 只能返回不透明 sourceId；它不能提交路径、URI、源码或 shell 命令。完整的动态对象 adapter 还需要可信 server 端 Manifest 记录提供器，当前 Vite 插件尚未暴露稳定注册 API。

## Production Boundary

Runtime 只允许出现在开发 serve 页面。消费应用的生产构建必须搜索并确认不存在 Runtime 模块名、`data-wsi-*` marker、`wsi:browser:*` 事件和 Bridge 信息。

## License

MIT，见 [LICENSE](LICENSE)。
