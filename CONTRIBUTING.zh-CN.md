# 为 Web Source Inspector 贡献代码

感谢你有兴趣为 Web Source Inspector 做出贡献！🎉

## 贡献方式

- 🐛 通过 [GitHub Issues](https://github.com/Rich-hy/web-source-inspector/issues) 报告 bug
- 💡 提出新功能建议
- 📖 改进文档
- 🔧 通过 Pull Request 提交 bug 修复或新功能

## 开发环境设置

### 环境要求

- Node.js >= 20.19.0
- pnpm >= 10.0.0
- VS Code >= 1.90 或 Cursor

### 开始开发

1. Fork 并克隆仓库：
```bash
git clone https://github.com/YOUR_USERNAME/web-source-inspector.git
cd web-source-inspector
```

2. 安装依赖：
```bash
pnpm install
```

3. 构建所有包：
```bash
pnpm build
```

4. 启动开发测试项目：
```bash
pnpm dev:basic
```

5. 打包 VSIX 插件：
```bash
pnpm package:vsix
```

## 项目结构

```
packages/
├── protocol/           # 协议定义和验证
├── compiler-core/      # Source ID 和 manifest 管理
├── transform-vue/      # Vue SFC AST 转换
├── runtime/            # 浏览器端 inspector UI
├── dev-session-core/   # Session 和桥接管理
├── vite-plugin/        # Vite 适配器
├── adapter-webpack/    # Webpack/Vue CLI 适配器
├── init-core/          # 项目初始化逻辑
├── web-source-inspector/     # 公开的 npm 包
└── vscode-extension/   # VS Code/Cursor 插件

fixtures/               # 测试项目
├── basic/             # 基础 Vite + Vue 3 项目
├── webpack-basic/     # 基础 Webpack 项目
├── element-plus/      # Element Plus 集成
└── monorepo/          # Monorepo 配置

docs/                  # 文档（中文）
tests/                 # E2E 测试
```

## 运行测试

```bash
# 类型检查
pnpm typecheck

# 单元测试
pnpm test

# E2E 测试（需要 Chromium）
pnpm test:e2e

# 如果需要，安装 Chromium
pnpm exec playwright install chromium
```

## 提交修改

1. 创建新分支：
```bash
git checkout -b feature/your-feature-name
```

2. 进行修改并提交：
```bash
git add .
git commit -m "feat: add new feature"
```

遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：
- `feat:` - 新功能
- `fix:` - Bug 修复
- `docs:` - 文档修改
- `chore:` - 构建或工具修改
- `test:` - 测试添加或修改

3. 推送到你的 fork：
```bash
git push origin feature/your-feature-name
```

4. 在 GitHub 上创建 Pull Request

## 代码规范

- 所有新代码使用 TypeScript
- 遵循现有的代码风格和约定
- 为新功能添加测试
- 必要时更新文档
- 保持 commit 聚焦和原子化

## 需要帮助？

- 📖 阅读[文档](https://github.com/Rich-hy/web-source-inspector/blob/main/docs/)
- 💬 在 [GitHub Discussions](https://github.com/Rich-hy/web-source-inspector/discussions) 提问
- 🐛 通过 [GitHub Issues](https://github.com/Rich-hy/web-source-inspector/issues) 报告问题

## 许可协议

通过贡献代码，你同意你的贡献将以 MIT 许可协议授权。
