# Contributing to Web Source Inspector

Thank you for your interest in contributing to Web Source Inspector! 🎉

## Ways to Contribute

- 🐛 Report bugs via [GitHub Issues](https://github.com/Rich-hy/web-source-inspector/issues)
- 💡 Suggest new features
- 📖 Improve documentation
- 🔧 Submit bug fixes or new features via Pull Requests

## Development Setup

### Prerequisites

- Node.js >= 20.19.0
- pnpm >= 10.0.0
- VS Code >= 1.90 or Cursor

### Getting Started

1. Fork and clone the repository:
```bash
git clone https://github.com/YOUR_USERNAME/web-source-inspector.git
cd web-source-inspector
```

2. Install dependencies:
```bash
pnpm install
```

3. Build all packages:
```bash
pnpm build
```

4. Start the development fixture:
```bash
pnpm dev:basic
```

5. Package the VSIX extension:
```bash
pnpm package:vsix
```

## Project Structure

```
packages/
├── protocol/           # Protocol definitions and validation
├── compiler-core/      # Source ID and manifest management
├── transform-vue/      # Vue SFC AST transformations
├── runtime/            # Browser inspector UI
├── dev-session-core/   # Session and bridge management
├── vite-plugin/        # Vite adapter
├── adapter-webpack/    # Webpack/Vue CLI adapter
├── init-core/          # Project initialization logic
├── web-source-inspector/     # Public npm package
└── vscode-extension/   # VS Code/Cursor extension

fixtures/               # Test projects
├── basic/             # Basic Vite + Vue 3 project
├── webpack-basic/     # Basic Webpack project
├── element-plus/      # Element Plus integration
└── monorepo/          # Monorepo setup

docs/                  # Documentation (Chinese)
tests/                 # E2E tests
```

## Running Tests

```bash
# Type checking
pnpm typecheck

# Unit tests
pnpm test

# E2E tests (requires Chromium)
pnpm test:e2e

# Install Chromium if needed
pnpm exec playwright install chromium
```

## Submitting Changes

1. Create a new branch:
```bash
git checkout -b feature/your-feature-name
```

2. Make your changes and commit:
```bash
git add .
git commit -m "feat: add new feature"
```

Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `chore:` - Build or tooling changes
- `test:` - Test additions or modifications

3. Push to your fork:
```bash
git push origin feature/your-feature-name
```

4. Open a Pull Request on GitHub

## Code Guidelines

- Use TypeScript for all new code
- Follow existing code style and conventions
- Add tests for new features
- Update documentation when needed
- Keep commits focused and atomic

## Need Help?

- 📖 Read the [documentation](https://github.com/Rich-hy/web-source-inspector/blob/main/docs/)
- 💬 Ask in [GitHub Discussions](https://github.com/Rich-hy/web-source-inspector/discussions)
- 🐛 Report issues via [GitHub Issues](https://github.com/Rich-hy/web-source-inspector/issues)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
