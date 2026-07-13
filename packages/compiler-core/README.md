# @web-source-inspector/compiler-core

Web Source Inspector 的框架无关编译核心，负责 sourceId、`SourceRecord`、摘要、wire path、候选排序和内存 Manifest。

## Status

当前版本为 `0.1.0` 开发实现，尚未声明已发布到 npm。它主要供 source transform 和 Vite/server adapter 使用，不包含浏览器 UI 或 IDE 打开逻辑。

## Main Exports

- `createSessionSourceKey`、`createSourceIdGenerator`、`createRootKey`。
- `createSourceDigest` 和局部 snippet digest。
- `SourceManifest`、generation、容量限制和 stale tombstone。
- `resolveSourceCandidates` 和候选偏好。
- wire path、workspace 相对路径和 root identity 工具。
- `SourceRecord`、`SourceRange` 和相关类型。

```ts
import {
  createSessionSourceKey,
  createSourceIdGenerator,
  SourceManifest,
} from '@web-source-inspector/compiler-core';

const sessionKey = createSessionSourceKey();
const createSourceId = createSourceIdGenerator(sessionKey);
const manifest = new SourceManifest();
```

调用方应按模块收集完整记录，再使用 Manifest 的模块级替换流程提交。HMR 后必须让旧 ID 返回 stale，不能把旧 ID 猜测到新文件或新位置。

## Security

本包提供 wire path 规范化和 Manifest 约束，但不会替代 IDE 端的 `realpath`、symlink/Junction 和 workspace containment 校验。Browser 的业务定位值仍只能是不透明 sourceId，认证和会话绑定由 Browser Transport 独立处理。

## License

MIT，见 [LICENSE](LICENSE)。
