# @web-source-inspector/vite-plugin

Web Source Inspector 的 Vue/Vite 集成包，连接 SFC transform、Browser Runtime、内存 Manifest、Browser Router 和认证 loopback IDE Bridge。

## Status

当前版本为 `0.1.0-beta.2` 发布候选。Adapter 合同覆盖 Vite 2.9～6 和 Vue 2.6/2.7/3.2+；各真实 Vue/Vite plugin 组合仍需发布矩阵验证。

当次同机网卡 IP 证据覆盖仓库 Vite `6.4.3` 与消费项目 Vite `6.4.1`；没有第二设备或隔离 VM 的拒绝证据，不声明其它设备已验证拒绝。

## Usage

将插件放在 Vue 插件之前：

```ts
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { webSourceInspector } from '@web-source-inspector/vite-plugin';

export default defineConfig({
  plugins: [webSourceInspector(), vue()],
});
```

插件使用 `apply: 'serve'` 和 `enforce: 'pre'`，不需要修改 `index.html`、业务入口、路由或根组件。

统一公开包可以把预编译 Browser Runtime 作为稳定资产注入，不需要消费项目或 Node 运行时使用 `import.meta.resolve`：

```ts
webSourceInspector(options, {
  runtimeModuleSource: compiledBrowserRuntimeEsm,
});
```

未注入源码时，虚拟模块只引用稳定公开入口 `@web-source-inspector/runtime`。

## Main Options

- `workspaceRoot`、`sourceRoots`：限定可转换和可打开的 workspace 源码范围。
- `include`、`exclude`：进一步过滤用户源码。
- `bridge`：是否启动本机 IDE Bridge，默认开启。
- `browserAccess`：`same-machine`（默认）或 `loopback`。默认模式只允许启动时快照中的本机网卡地址与回环地址。
- `debugLog`：输出脱敏诊断码。
- `compiler`：高级集成可注入当前 Vue plugin 实际使用的 compiler adapter；默认从消费项目解析。
- `ui`：关闭入口或配置按钮位置、快捷键、单次选择和语言。
- `remoteBrowser`：已弃用，当前只允许 `false`，没有远程配对能力。

### 同机网卡 IP

默认的 `webSourceInspector()` 已使用 `same-machine`。`server.host` 仍必须允许本机网卡访问，例如 `0.0.0.0` 或精确本机 IP。插件只使用实际 listener 的端口，冻结网卡地址和 Origin 集合；非回环 socket 必须与 Origin 的字面量 IP 完全相同。需要仅允许回环地址时，配置 `webSourceInspector({ browserAccess: 'loopback' })`。网卡变化后重启 Dev Server。该选项不支持代理、转发、其它电脑或手机。

## Security

- Bridge 只监听 `127.0.0.1`，使用随机 token、随机 path 和固定 subprotocol。
- Browser 的业务定位值只提交当前 Manifest 的 sourceId；Browser Transport 另携带专用认证和必要会话元数据。
- Browser metadata/result 不返回 relativePath、range、源码上下文或候选位置。
- 插件不执行 shell，也不接受 Browser 路径。
- IDE 仍必须重新验证 rootKey、wire path、realpath 和 workspace containment。

session、Manifest、Bridge 和 Browser Runtime 只在真实 `configureServer` 生命周期创建；build 和 preview 不注入 marker 或客户端代码。生产消费项目仍必须对实际构建产物执行 Runtime、marker、Bridge 和绝对路径字符串扫描。

## Third-Party Licenses

IDE Bridge 通过 `@web-source-inspector/dev-session-core` 使用 `ws`；许可证评估见仓库根 `THIRD_PARTY_NOTICES.md`。

## License

MIT，见 [LICENSE](LICENSE)。
