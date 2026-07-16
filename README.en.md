# Web Source Inspector

> [简体中文](README.md) | English

**Instantly locate Vue component source code from browser elements**

Click any element in your browser and automatically open the corresponding `.vue` file in VS Code or Cursor, jumping to the exact line. Supports Vite, Webpack, and Vue CLI projects.

![Version](https://img.shields.io/badge/npm-0.1.0--beta.4-blue)
![VS Code Extension](https://img.shields.io/badge/vsix-0.1.1-green)

---

## Quick Start

### Requirements

- **Node.js** ≥ 16.20.2
- **Vue** 2.6 / 2.7 / 3.2+
- **Build Tool**: Vite 2.9+ or Webpack 4/5 (including Vue CLI)
- **Editor**: VS Code ≥ 1.90 or Cursor

> ⚠️ Browser, development server, and IDE must be on the same machine

---

## Installation (3 Steps)

### Step 1: Install npm Package

Run in your Vue project root directory:

```bash
npm install -D web-source-inspector
```

Or use other package managers:

```bash
# pnpm
pnpm add -D web-source-inspector

# yarn
yarn add -D web-source-inspector
```

### Step 2: Install VS Code/Cursor Extension

1. Go to [GitHub Releases](https://github.com/Rich-hy/web-source-inspector/releases/latest)
2. Download `web-source-inspector.vsix` file
3. In VS Code or Cursor:
   - Open Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
   - Click `...` menu in the top right corner
   - Select **"Install from VSIX..."**
   - Choose the downloaded `.vsix` file

### Step 3: Enable for Your Project

Open your Vue project and choose either method:

#### Method 1: Using Command Line

```bash
npx web-source-inspector init
```

#### Method 2: Using VS Code/Cursor Command

1. Press `Ctrl+Shift+P` / `Cmd+Shift+P` to open command palette
2. Type and select **"Source Inspector: Enable Project"**
3. Review the configuration preview and confirm

> 💡 The tool automatically detects your build tool (Vite/Webpack/Vue CLI) and only modifies necessary config files without touching your business code.

---

## Usage

### 1. Start Development Server

Launch your project as usual:

```bash
npm run dev
# or
npm run serve
```

### 2. Open Browser

Visit your development server (e.g., `http://localhost:5173`). An Inspector button will appear in the bottom-right corner.

### 3. Select Element

**Method 1: Click Button**
- Click the Inspector button in the bottom-right corner
- Hover over target element (it will be highlighted)
- Click the element

**Method 2: Keyboard Shortcut**
- Press `Alt+Shift+C` to enter selection mode
- Hover and click target element

### 4. Source Opens Automatically

VS Code/Cursor will automatically open the corresponding `.vue` file and navigate to the exact location in the template.

### Keyboard Shortcuts

| Action | Description |
|--------|-------------|
| `Esc` | Exit selection mode |
| `Click` | Select element and open source |
| `Shift + Click` | Prioritize component call site |
| `Alt + Click` | Prioritize control flow (e.g., `v-if`) |

---

## Verification and Uninstallation

### Check Project Status

```bash
npx web-source-inspector doctor
```

This command checks:
- Dependencies are correctly installed
- Configuration is properly written
- Build tool versions are compatible

### Uninstall

To remove project configuration:

```bash
npx web-source-inspector remove
```

Then remove the dependency from `package.json`:

```bash
npm uninstall web-source-inspector
```

---

## Supported Features

✅ Plain DOM elements, components, `v-for`, `v-if`, Slots, dynamic components, Teleport  
✅ Element selection and highlighting inside Shadow DOM  
✅ Same-machine network IP access (Vite projects, requires `server.host` config)  
✅ Session management for multiple browser tabs and IDE windows  
✅ Automatic source mapping sync after HMR updates  

---

## Compatibility

| Type | Supported Versions |
|------|-------------------|
| **Vue** | 2.6.x, 2.7.x, 3.2+ |
| **Vite** | 2.9.0 ~ 6.x |
| **Webpack** | 4.x, 5.x |
| **Vue CLI** | 3.x, 4.x, 5.x |
| **Package Manager** | npm, pnpm, Yarn (node_modules mode) |

### Not Currently Supported

- ❌ React, Svelte, or other frameworks
- ❌ Pug/MDX template syntax
- ❌ SSR (Server-Side Rendering)
- ❌ WSL, Docker, Remote SSH, Dev Container
- ❌ Remote browsers on other devices
- ❌ Yarn PnP, Bun

---

## Troubleshooting

### Issue 1: Inspector Button Not Appearing

**Possible causes:**
- Project configuration not properly written
- Development server not restarted

**Solution:**
```bash
# Check project status
npx web-source-inspector doctor

# If configuration is incorrect, re-enable
npx web-source-inspector remove
npx web-source-inspector init

# Restart development server
npm run dev
```

### Issue 2: IDE Doesn't Respond After Clicking Element

**Possible causes:**
- VS Code/Cursor extension not installed
- IDE hasn't opened the project workspace
- Workspace is not trusted

**Solution:**
1. Confirm extension is installed (search "Web Source Inspector" in Extensions panel)
2. Confirm IDE opened the project as a folder (not a single file)
3. If prompted about untrusted workspace, choose "Trust this workspace"

### Issue 3: Webpack Project Configuration Failed

**Possible causes:**
- Missing `vue-loader`
- Vue version doesn't match `vue-loader` version

**Solution:**
```bash
# Check diagnostic information
npx web-source-inspector doctor

# Install missing dependencies as suggested
npm install -D vue-loader
```

For more issues, see [Troubleshooting Documentation](docs/troubleshooting.md).

---

## Same-Machine Network Access (Vite Projects)

By default, the tool allows access via local IP address (e.g., `http://192.168.1.100:5173`), provided Vite is configured for network access:

```js
// vite.config.js
export default {
  server: {
    host: '0.0.0.0' // or specific local IP
  }
}
```

To restrict to loopback addresses only (`localhost`/`127.0.0.1`), explicitly specify in plugin configuration:

```js
import { webSourceInspector } from 'web-source-inspector/vite'

export default {
  plugins: [
    webSourceInspector({
      browserAccess: 'loopback' // Only allow localhost
    })
  ]
}
```

> ⚠️ IDE Bridge always listens on `127.0.0.1` only; other devices cannot connect.

---

## Security

- ✅ Browser only sends opaque `sourceId`, no file paths or source code content
- ✅ IDE Bridge only listens on local loopback address (`127.0.0.1`), inaccessible from external devices
- ✅ Production builds (`build`/`production` mode) automatically disable all features and inject no code
- ✅ IDE verifies paths are within workspace before opening files, rejecting external paths

**Pre-release check:** Please follow [Security Documentation](docs/security.md#生产构建核验) to scan production build artifacts for any residual debug code.

If you discover a security issue, please report it privately following [SECURITY.md](SECURITY.md).

---

## Documentation

- [Configuration Options](docs/quick-start.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [Security Model](docs/security.md)
- [Capability Matrix](docs/capabilities.md)
- [Changelog](CHANGELOG.md)

---

## Local Development (Contributors)

If you want to contribute or build locally:

```bash
# Requirements: Node.js >= 20.19.0, pnpm >= 10

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Start test project
pnpm dev:basic

# Package VSIX extension
pnpm package:vsix
# Output: packages/vscode-extension/web-source-inspector.vsix

# Run tests
pnpm test
pnpm test:e2e
```

Install Chromium before the first Playwright run if not already present:

```bash
pnpm exec playwright install chromium
```

For detailed development guide, see project documentation.

---

## License

[MIT](LICENSE)

Third-party dependency licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
