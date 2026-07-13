# Webpack real fixture gate

本目录当前只记录阶段 5 必须执行的真实兼容性闸门，mock 测试不能替代这些结果。
固定依赖并逐项执行业务 build/dev-server 后，每个 fixture 都必须断言实际 template request loader chain、render 输出中的 marker 和 server-only SourceRecord：

1. Vue 2.6 + Vue CLI 3 + Webpack 4 + vue-loader 15 + WDS 3.x。
2. Vue 2.6 + Vue CLI 4 + Webpack 4 + vue-loader 15 + WDS 3.x。
3. Vue 3.2 + Vue CLI 5 + Webpack 5 + vue-loader 17 + WDS 4.7+。
4. Vue 2.6 + raw Webpack 4 + vue-loader 15 + cache-loader。
5. Vue 2.7 + raw Webpack 5 + vue-loader 15 + filesystem cache。
6. Vue 3.2 + raw Webpack 4/5 + vue-loader 16。
7. Vue 3.5 + raw Webpack 5 + vue-loader 17 + WDS 4.7+。

执行入口将在 fixture package 落地后统一为 `pnpm --filter <fixture-name> test:integration`。在这些命令和浏览器 E2E 实际运行前，不得将对应 tuple 标记为已验证。
