# @web-source-inspector/transform-vue

Web Source Inspector 的 Vue SFC AST transform，为模板节点生成 `SourceRecord`，并注入 DOM/组件调用点 marker 与 sourcemap。

## Status

当前版本为 `0.1.0` 开发实现，尚未声明已发布到 npm。普通项目应优先使用 `@web-source-inspector/vite-plugin`，而不是直接调用本包。

## Main API

`transformVueSfc(options)` 接收完整 SFC 源码、规范文件身份、workspace 相对路径、模块 generation、session 级 sourceId 生成器和消费项目 compiler adapter，返回：

- 转换后的代码和可选 sourcemap。
- 当前模块的 `SourceRecord[]`。
- 结构化诊断。
- 是否实际转换。

转换覆盖 Vue 2.6、Vue 2.7 和 Vue 3.2+ 的普通元素、项目组件、循环、条件、Slot、Fragment、Teleport 和动态组件等 HTML template 节点。`<template src>` 和非 HTML `template lang` 当前返回明确诊断，不会尝试字符串级注入。

## Integration Rules

- 在 Vue 插件前执行，并通过 `createVue26CompilerAdapter`、`createVue27CompilerAdapter` 或 `createVue3CompilerAdapter` 注入 bundler 实际使用的 compiler。兼容入口可通过 `compilerRoot` 解析项目 compiler，但正式 adapter 应优先显式注入。
- `relativePath` 必须是 workspace 相对 POSIX 路径。
- 模块内或 Manifest 中不同记录发生 sourceId 碰撞时必须让本次转换失败，不追加后缀或静默消歧；`finalizeRecords` 成功后才写入 marker。
- 保留完整 SFC 的 UTF-16 坐标和 sourcemap。
- 检测 `data-wsi-source`、`data-wsi-component-source` 用户属性冲突，不覆盖业务值。

本包不是通用 Adapter SDK。其它框架或预处理语言需要独立 parser、坐标映射和验证矩阵。

## Third-Party Licenses

Vue compiler 与 Magic String 的许可证评估见仓库根 `THIRD_PARTY_NOTICES.md`。发布 tarball 时仍应检查实际依赖和归档内容。

## License

MIT，见 [LICENSE](LICENSE)。
