# Security Policy

Web Source Inspector 可以触发 IDE 打开本机源码，因此安全问题包括但不限于路径逃逸、Bridge 认证绕过、跨 workspace 打开、token 泄漏、恶意 Browser 消息和生产构建泄漏。

完整安全模型见 [docs/security.md](docs/security.md)。

## Supported Versions

当前没有公开稳定版本。安全修复只面向仓库中的最新 `0.1.x` 开发线，不为旧快照承诺补丁或响应期限。

| Version | Supported |
| --- | --- |
| 最新 `0.1.x` 开发线 | Best effort |
| 更早版本或私有快照 | No |

## Private Reporting

请不要在公开 issue、讨论区、日志粘贴或录屏中披露可利用细节。

1. 首选仓库托管平台提供的 **Private vulnerability reporting** 或 **Security Advisories / Report a vulnerability** 入口。
2. 如果当前仓库页面没有私下报告入口，请先通过项目维护者已经建立的私有协作渠道索取安全联系人，只发送不含利用细节的简短请求。
3. 当前仓库没有声明可公开使用的安全邮箱，因此不要猜测地址，也不要把完整报告发送到未经确认的联系人。

报告建议包含：

- 受影响版本、操作系统、IDE、Node.js、Vite 和 Vue 版本。
- 最小复现步骤、预期行为和实际行为。
- 风险影响，例如可打开的路径范围、是否需要同一用户权限、是否涉及远程客户端。
- 已脱敏的协议消息、错误码和调用栈。
- 建议的临时缓解方式。

请不要提交真实 token、Authorization header、私有源码、未脱敏绝对路径、用户目录或带敏感 query 的 URL。需要共享复现工程时，使用不包含业务数据的最小 fixture。

## Disclosure Process

- 维护者确认报告渠道后，再通过同一私下渠道交换技术细节。
- 修复完成前避免公开可直接利用的 payload、路径或绕过步骤。
- 公开说明应包含影响范围、修复版本和升级/缓解方式，但不得包含密钥或真实项目数据。
- 如果问题实际来自 Vite、Vue、VS Code、Cursor 或第三方依赖，应先与对应上游协调披露。

## Security Boundaries

当前首版只承诺 Dev Server、Extension Host 和源码位于同一台本机。远程浏览器、WSL、Remote SSH、Dev Container、Codespaces 和把 Bridge 暴露到 `0.0.0.0` 均不在支持范围内。
